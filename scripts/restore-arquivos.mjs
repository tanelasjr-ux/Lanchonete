#!/usr/bin/env node
/**
 * Restaura os ARQUIVOS do Supabase Storage a partir de `yarn backup:arquivos`.
 * ============================================================================
 * Par do `scripts/backup-arquivos.mjs`. Recria os buckets com a MESMA config
 * (public, limite de tamanho, mime types), envia cada arquivo no mesmo caminho
 * e confere o tamanho de volta.
 *
 * `--trocar-origem`: quando o destino e OUTRO projeto (ex.: migracao de
 * regiao), as URLs publicas gravadas no banco ainda apontam para o projeto de
 * origem (`https://<ref-antigo>.supabase.co/storage/...`). Esta opcao troca o
 * host antigo pelo novo nas colunas que guardam essas URLs — `empresas.logo`,
 * `empresas.cardapio_imagem_url` e `empresas.config` (jsonb) —, numa
 * transacao, e confere que nao sobrou nenhuma referencia ao projeto antigo.
 * Se uma coluna nova passar a guardar URL de Storage, inclua-a em COLUNAS_URL.
 *
 * USO
 *   yarn restore:arquivos                        # lista backups de arquivos
 *   yarn restore:arquivos ultimo                 # SIMULA (nada e enviado)
 *   yarn restore:arquivos ultimo --executar [--trocar-origem]
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..')
const arquivoEnv = join(RAIZ, '.env')
if (existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv)

const DESTINO = process.env.BACKUP_DIR || 'D:\\Backups\\RestauranteOS'
const args = process.argv.slice(2)
const EXECUTAR = args.includes('--executar')
const TROCAR = args.includes('--trocar-origem')
const alvo = args.find((a) => !a.startsWith('--'))
const COLUNAS_URL = [
  { tabela: 'empresas', coluna: 'logo', tipo: 'text' },
  { tabela: 'empresas', coluna: 'cardapio_imagem_url', tipo: 'text' },
  { tabela: 'empresas', coluna: 'config', tipo: 'jsonb' },
]
const log = (m) => console.log(`[restore:arquivos] ${m}`)

async function resolverPasta() {
  const pastas = existsSync(DESTINO) ? (await readdir(DESTINO)).filter((f) => f.startsWith('arquivos-')).sort() : []
  if (!alvo) {
    log(`backups de arquivos em ${DESTINO}:`)
    for (const p of pastas) log(`  ${p}`)
    if (!pastas.length) log('  (nenhum)')
    log('uso: yarn restore:arquivos ultimo|<pasta> [--executar] [--trocar-origem]')
    process.exit(0)
  }
  if (alvo === 'ultimo') {
    if (!pastas.length) throw new Error('nenhum backup de arquivos')
    return join(DESTINO, pastas[pastas.length - 1])
  }
  const p = isAbsolute(alvo) ? alvo : join(DESTINO, alvo)
  if (!existsSync(join(p, 'manifest.json'))) throw new Error(`manifest.json nao encontrado em ${p}`)
  return p
}

async function api(metodo, caminho, corpo, extraHeaders = {}) {
  const { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: chave } = process.env
  const resp = await fetch(`${base}/storage/v1${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, apikey: chave, ...extraHeaders },
    body: corpo,
  })
  const texto = await resp.text()
  return { ok: resp.ok, status: resp.status, texto }
}

async function main() {
  const { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: chave, SUPABASE_DB_URL: dbUrl } = process.env
  if (!base || !chave || !dbUrl) throw new Error('faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL')
  const pasta = await resolverPasta()
  const manifest = JSON.parse(await readFile(join(pasta, 'manifest.json'), 'utf8'))
  if (manifest.formato !== 'restaurante-os-arquivos/1') throw new Error(`formato desconhecido: ${manifest.formato}`)

  const hostOrigem = new URL(manifest.origem).host
  const hostDestino = new URL(base).host
  log(`backup: ${pasta}`)
  log(`origem: ${hostOrigem}  ->  destino: ${hostDestino}`)
  log(EXECUTAR ? 'MODO: EXECUTAR' : 'MODO: simulacao (nada sera enviado; use --executar)')
  if (TROCAR && hostOrigem === hostDestino) throw new Error('--trocar-origem com origem == destino nao faz sentido')

  // Todos os arquivos do manifesto existem em disco com o tamanho certo?
  const { stat } = await import('node:fs/promises')
  for (const o of manifest.objetos) {
    const s = await stat(join(pasta, o.bucket_id, ...o.name.split('/')))
    if (o.tamanho != null && s.size !== o.tamanho) throw new Error(`arquivo local corrompido: ${o.bucket_id}/${o.name}`)
  }
  log(`${manifest.buckets.length} buckets, ${manifest.objetos.length} arquivos conferidos em disco`)

  if (!EXECUTAR) {
    for (const b of manifest.buckets) log(`  criaria/atualizaria bucket ${b.id} (public=${b.public}, limite=${b.file_size_limit ?? 'sem'})`)
    if (TROCAR) log(`  trocaria ${hostOrigem} por ${hostDestino} em ${COLUNAS_URL.map((c) => `${c.tabela}.${c.coluna}`).join(', ')}`)
    log('simulacao OK. Nada foi enviado.')
    return
  }

  // 1) Buckets com a mesma config (cria; se ja existe, atualiza).
  for (const b of manifest.buckets) {
    const cfg = { id: b.id, name: b.name, public: b.public, file_size_limit: b.file_size_limit, allowed_mime_types: b.allowed_mime_types }
    let r = await api('POST', '/bucket', JSON.stringify(cfg), { 'Content-Type': 'application/json' })
    if (!r.ok && /already exists|Duplicate/i.test(r.texto)) {
      r = await api('PUT', `/bucket/${encodeURIComponent(b.id)}`, JSON.stringify(cfg), { 'Content-Type': 'application/json' })
    }
    if (!r.ok) throw new Error(`bucket ${b.id}: ${r.status} ${r.texto}`)
    log(`bucket ${b.id} OK`)
  }

  // 2) Arquivos (upsert: pode rodar de novo sem duplicar).
  let enviados = 0
  for (const o of manifest.objetos) {
    const conteudo = await readFile(join(pasta, o.bucket_id, ...o.name.split('/')))
    const caminho = `/object/${encodeURIComponent(o.bucket_id)}/${o.name.split('/').map(encodeURIComponent).join('/')}`
    const r = await api('POST', caminho, conteudo, {
      'Content-Type': o.mimetype || 'application/octet-stream',
      'x-upsert': 'true',
    })
    if (!r.ok) throw new Error(`upload ${o.bucket_id}/${o.name}: ${r.status} ${r.texto}`)
    enviados++
  }
  log(`${enviados} arquivos enviados`)

  // 3) Confere pelo banco de destino: mesmos caminhos e tamanhos.
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { ca: await readFile(join(RAIZ, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()
  try {
    const { rows } = await client.query(
      `select bucket_id, name, (metadata->>'size')::bigint tamanho from storage.objects`)
    const noDestino = new Map(rows.map((r) => [`${r.bucket_id}/${r.name}`, Number(r.tamanho)]))
    const faltando = manifest.objetos.filter((o) => noDestino.get(`${o.bucket_id}/${o.name}`) !== o.tamanho)
    if (faltando.length) throw new Error(`${faltando.length} arquivo(s) ausentes ou com tamanho diferente no destino`)
    log(`conferido no destino: ${manifest.objetos.length}/${manifest.objetos.length} arquivos com tamanho certo`)

    // 4) URLs gravadas no banco.
    if (TROCAR) {
      await client.query('BEGIN')
      for (const c of COLUNAS_URL) {
        const col = `"${c.coluna}"`
        const expr = c.tipo === 'jsonb'
          ? `replace(${col}::text, $1, $2)::jsonb`
          : `replace(${col}, $1, $2)`
        const r = await client.query(
          `update public."${c.tabela}" set ${col} = ${expr} where ${col}::text like '%' || $1 || '%'`,
          [hostOrigem, hostDestino])
        log(`  ${c.tabela}.${c.coluna}: ${r.rowCount} linha(s) atualizada(s)`)
      }
      const sobra = []
      for (const c of COLUNAS_URL) {
        const { rows: [{ n }] } = await client.query(
          `select count(*)::int n from public."${c.tabela}" where "${c.coluna}"::text like '%' || $1 || '%'`, [hostOrigem])
        if (n) sobra.push(`${c.tabela}.${c.coluna}: ${n}`)
      }
      if (sobra.length) {
        await client.query('ROLLBACK')
        throw new Error(`ainda ha referencias ao projeto antigo (${sobra.join(', ')}) — ROLLBACK`)
      }
      await client.query('COMMIT')
      log('URLs trocadas para o projeto novo.')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await client.end()
  }
  log('OK.')
}

main().catch((e) => {
  console.error(`[restore:arquivos] FALHOU: ${e.message}`)
  process.exit(1)
})
