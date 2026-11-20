#!/usr/bin/env node
/**
 * Restauracao de backup do banco de producao (Supabase) do Restaurant OS.
 * ============================================================================
 * Par do `scripts/backup-db.mjs`. Le um arquivo `restaurante-os-*.json.gz` e
 * devolve os DADOS ao schema `public`. O schema em si (tabelas, colunas,
 * funcoes) nao e restaurado — ele vem das migrations.
 *
 * USO
 *
 *   yarn restore                         # lista os backups disponiveis
 *   yarn restore ultimo                  # SIMULA a restauracao do mais recente
 *   yarn restore <arquivo>               # SIMULA a restauracao de um arquivo
 *   yarn restore ultimo --tabelas=a,b    # so essas tabelas
 *   yarn restore ultimo --executar       # restaura DE VERDADE
 *
 * SEGURANCA (decisoes nao obvias)
 *
 * 1. **Simulacao por padrao.** Sem `--executar`, faz a restauracao inteira
 *    dentro de uma transacao, confere tudo e da ROLLBACK. Ou seja, a
 *    simulacao exercita exatamente o mesmo caminho do modo real — se ela
 *    passa, o real passa.
 * 2. **Backup automatico antes do modo real.** `--executar` roda o
 *    `backup-db.mjs` primeiro; se o backup falhar, nada e restaurado. Uma
 *    restauracao errada continua tendo volta.
 * 3. **Tudo numa transacao so.** Ou todas as tabelas voltam, ou nenhuma.
 * 4. **`session_replication_role = replica`** durante a transacao: desliga
 *    as checagens de FK e os triggers, necessario porque ha ciclos de FK
 *    (mesas <-> comandas) e porque o trigger de numeracao de pedidos nao
 *    deve renumerar nada. Para compensar, ANTES do commit o script confere
 *    manualmente todas as FKs do schema; havendo registro orfao, ROLLBACK.
 *    (Isso importa sobretudo em restauracao parcial com `--tabelas`.)
 * 5. **`schema_migrations` nunca e restaurada** — e o controle do migrator,
 *    reflete o schema real, nao dados.
 * 6. **So colunas presentes no backup sao inseridas.** Coluna criada por
 *    migration mais nova que o backup fica com o DEFAULT dela, em vez de
 *    NULL forcado. Diferenca de migrations entre backup e banco gera aviso.
 * 7. Tabela que existe no banco mas nao no backup: intocada (com aviso).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import pg from 'pg'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..')
const arquivoEnv = join(RAIZ, '.env')
if (existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv)

const DESTINO = process.env.BACKUP_DIR || 'D:\\Backups\\RestauranteOS'
const PREFIXO = 'restaurante-os-'
const NUNCA_RESTAURAR = new Set(['schema_migrations'])
const LOTE = 500

const args = process.argv.slice(2)
const EXECUTAR = args.includes('--executar')
const optTabelas = args.find((a) => a.startsWith('--tabelas='))
const alvo = args.find((a) => !a.startsWith('--'))

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`
const log = (m) => console.log(`[restore] ${m}`)

async function listarBackups() {
  if (!existsSync(DESTINO)) return []
  return (await readdir(DESTINO)).filter((f) => f.startsWith(PREFIXO) && f.endsWith('.json.gz')).sort()
}

async function resolverArquivo() {
  const lista = await listarBackups()
  if (!alvo) {
    log(`backups em ${DESTINO}:`)
    if (!lista.length) log('  (nenhum)')
    for (const f of lista) log(`  ${f}`)
    log('uso: yarn restore ultimo | yarn restore <arquivo> [--tabelas=a,b] [--executar]')
    process.exit(0)
  }
  if (alvo === 'ultimo') {
    if (!lista.length) throw new Error(`nenhum backup em ${DESTINO}`)
    return join(DESTINO, lista[lista.length - 1])
  }
  const caminho = isAbsolute(alvo) ? alvo : existsSync(alvo) ? alvo : join(DESTINO, alvo)
  if (!existsSync(caminho)) throw new Error(`arquivo nao encontrado: ${alvo}`)
  return caminho
}

async function main() {
  const caminho = await resolverArquivo()
  const dump = JSON.parse(gunzipSync(readFileSync(caminho)).toString('utf8'))
  if (dump.formato !== 'restaurante-os-backup/1') throw new Error(`formato desconhecido: ${dump.formato}`)

  const url = process.env.SUPABASE_DB_URL
  if (!url) throw new Error('SUPABASE_DB_URL nao definida (.env)')

  log(`arquivo: ${basename(caminho)} (gerado em ${dump.gerado_em})`)
  // Usuario do pooler e `postgres.<ref-do-projeto>`: deixa explicito QUAL
  // projeto vai receber os dados (importante quando ha mais de um .env).
  const destinoUrl = new URL(url)
  log(`destino: projeto ${decodeURIComponent(destinoUrl.username).split('.')[1] || '?'} (${destinoUrl.hostname})`)
  log(EXECUTAR ? 'MODO: EXECUTAR — os dados atuais serao SUBSTITUIDOS' : 'MODO: simulacao (nada sera gravado; use --executar para valer)')

  if (EXECUTAR) {
    log('fazendo backup do estado ATUAL antes de restaurar...')
    const r = spawnSync(process.execPath, [join(AQUI, 'backup-db.mjs')], { stdio: 'inherit', env: process.env })
    if (r.status !== 0) throw new Error('backup previo falhou — restauracao cancelada, nada foi alterado')
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: { ca: await readFile(join(RAIZ, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()

  try {
    // Tabelas e colunas reais do banco agora.
    const { rows: cols } = await client.query(`
      select table_name t, column_name c from information_schema.columns
      where table_schema = 'public'
        and table_name in (select table_name from information_schema.tables
                           where table_schema = 'public' and table_type = 'BASE TABLE')`)
    const colunasBanco = new Map()
    for (const { t, c } of cols) {
      if (!colunasBanco.has(t)) colunasBanco.set(t, new Set())
      colunasBanco.get(t).add(c)
    }

    // Aviso de divergencia de schema.
    const { rows: mig } = await client.query('select versao from public.schema_migrations order by versao')
    const noBanco = mig.map((m) => m.versao)
    const soNoBanco = noBanco.filter((v) => !dump.migrations.includes(v))
    const soNoBackup = dump.migrations.filter((v) => !noBanco.includes(v))
    if (soNoBanco.length) log(`AVISO: migrations mais novas que o backup: ${soNoBanco.join(', ')}`)
    if (soNoBackup.length) log(`AVISO: backup tem migrations que o banco nao tem: ${soNoBackup.join(', ')}`)

    let tabelas = Object.keys(dump.tabelas).filter((t) => !NUNCA_RESTAURAR.has(t))
    if (optTabelas) {
      const pedidas = optTabelas.slice('--tabelas='.length).split(',').map((s) => s.trim()).filter(Boolean)
      const invalidas = pedidas.filter((t) => !tabelas.includes(t))
      if (invalidas.length) throw new Error(`tabela(s) fora do backup ou proibidas: ${invalidas.join(', ')}`)
      tabelas = pedidas
    }
    const ausentes = tabelas.filter((t) => !colunasBanco.has(t))
    if (ausentes.length) throw new Error(`tabela(s) do backup nao existem mais no banco: ${ausentes.join(', ')}`)
    if (!optTabelas) {
      const intocadas = [...colunasBanco.keys()].filter((t) => !(t in dump.tabelas) && !NUNCA_RESTAURAR.has(t))
      if (intocadas.length) log(`AVISO: tabelas sem dados no backup (ficam como estao): ${intocadas.join(', ')}`)
    }

    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')

    const resumo = []
    for (const t of tabelas) {
      const linhas = dump.tabelas[t]
      const { rows: [{ n: antes }] } = await client.query(`select count(*)::int n from public.${ident(t)}`)
      await client.query(`delete from public.${ident(t)}`)

      // Colunas = presentes no backup E no banco (ver decisao 6).
      const chaves = new Set()
      for (const l of linhas) for (const k of Object.keys(l)) chaves.add(k)
      const descartadas = [...chaves].filter((k) => !colunasBanco.get(t).has(k))
      if (descartadas.length) log(`AVISO: ${t}: colunas do backup que nao existem mais: ${descartadas.join(', ')}`)
      const usar = [...chaves].filter((k) => colunasBanco.get(t).has(k)).map(ident).join(', ')

      for (let i = 0; i < linhas.length; i += LOTE) {
        await client.query(
          `insert into public.${ident(t)} (${usar})
           select ${usar} from jsonb_populate_recordset(null::public.${ident(t)}, $1::jsonb)`,
          [JSON.stringify(linhas.slice(i, i + LOTE))],
        )
      }
      // Fidelidade: o que ficou gravado tem que ser identico, valor a valor,
      // ao que esta no backup (pega perda de precisao em numeric/timestamptz,
      // coluna que mudou de tipo, etc.). Compara como multiconjunto de linhas.
      const { rows: gravadas } = await client.query(`select to_jsonb(x) r from public.${ident(t)} x`)
      if (gravadas.length !== linhas.length) throw new Error(`${t}: esperado ${linhas.length} linhas, ficou ${gravadas.length}`)
      const canon = (obj, ks) => JSON.stringify(ks.map((k) => [k, obj[k] === undefined ? null : obj[k]]))
      const ks = [...chaves].filter((k) => colunasBanco.get(t).has(k)).sort()
      const esperado = linhas.map((l) => canon(l, ks)).sort()
      const obtido = gravadas.map(({ r }) => canon(r, ks)).sort()
      const difs = esperado.filter((s, i) => s !== obtido[i]).length
      if (difs) throw new Error(`${t}: ${difs} linha(s) gravadas diferem do backup — ROLLBACK`)
      resumo.push({ t, antes, depois: gravadas.length })
    }

    // Integridade referencial (compensa o replica — decisao 4).
    const { rows: fks } = await client.query(`
      select co.conname, cl.relname filho, pl.relname pai,
             array_agg(ca.attname::text order by k.ord) cols_filho,
             array_agg(pa.attname::text order by k.ord) cols_pai
      from pg_constraint co
      join pg_class cl on cl.oid = co.conrelid
      join pg_class pl on pl.oid = co.confrelid
      join pg_namespace n on n.oid = co.connamespace
      cross join lateral unnest(co.conkey, co.confkey) with ordinality as k(ck, pk, ord)
      join pg_attribute ca on ca.attrelid = co.conrelid and ca.attnum = k.ck
      join pg_attribute pa on pa.attrelid = co.confrelid and pa.attnum = k.pk
      where n.nspname = 'public' and co.contype = 'f'
      group by co.conname, cl.relname, pl.relname`)
    const orfaos = []
    for (const fk of fks) {
      const naoNulo = fk.cols_filho.map((c) => `f.${ident(c)} is not null`).join(' and ')
      const junta = fk.cols_filho.map((c, i) => `p.${ident(fk.cols_pai[i])} = f.${ident(c)}`).join(' and ')
      const { rows: [{ n }] } = await client.query(
        `select count(*)::int n from public.${ident(fk.filho)} f
         where ${naoNulo} and not exists (select 1 from public.${ident(fk.pai)} p where ${junta})`)
      if (n > 0) orfaos.push(`${fk.filho} -> ${fk.pai} (${fk.conname}): ${n} orfao(s)`)
    }

    for (const r of resumo) log(`  ${r.t.padEnd(24)} ${String(r.antes).padStart(6)} -> ${String(r.depois).padStart(6)} linhas`)
    log(`chaves estrangeiras conferidas: ${fks.length}`)

    if (orfaos.length) {
      await client.query('ROLLBACK')
      for (const o of orfaos) log(`  ORFAO: ${o}`)
      throw new Error('integridade referencial quebrada — ROLLBACK, nada foi alterado')
    }

    if (EXECUTAR) {
      await client.query('COMMIT')
      log(`RESTAURADO: ${resumo.length} tabela(s).`)
    } else {
      await client.query('ROLLBACK')
      log(`simulacao OK: ${resumo.length} tabela(s) restaurariam sem erro. Nada foi gravado.`)
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(`[restore] FALHOU: ${e.message}`)
  process.exit(1)
})
