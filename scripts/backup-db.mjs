#!/usr/bin/env node
/**
 * Backup logico do banco de producao (Supabase) do Restaurant OS.
 * ============================================================================
 * POR QUE ISTO EXISTE
 *
 * O projeto Supabase esta no plano gratuito, que NAO tem backup restauravel.
 * E o desenvolvimento local aponta direto para producao (decisao de
 * 2026-11-17, enquanto nao ha clientes). Este script e a rede de seguranca:
 * rodar ANTES de qualquer migration ou alteracao em massa de dados.
 *
 * O QUE ELE FAZ
 *
 * Exporta todas as tabelas do schema `public` (dados, nao indices — o schema
 * e recriado pelas migrations em `supabase/migrations/`) para um unico JSON
 * compactado com gzip, junto com a lista de migrations aplicadas e a contagem
 * de linhas por tabela. Mantem os ultimos N arquivos e apaga os mais antigos.
 *
 * Arquivos de imagem (Supabase Storage) NAO entram — vivem fora do Postgres.
 *
 * USO
 *
 *   yarn backup                      # grava em D:\Backups\RestauranteOS
 *   BACKUP_DIR=E:\outro yarn backup  # outra pasta
 *   BACKUP_KEEP=60 yarn backup       # manter 60 arquivos em vez de 30
 *
 * O ARQUIVO CONTEM DADOS DE CLIENTES (e-mails, hashes de senha, telefones).
 * Por isso o destino padrao fica FORA do repositorio — nunca versionar.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip, createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import pg from 'pg'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..')
const CAMINHO_CA = join(RAIZ, 'supabase', 'prod-ca-2021.crt')

const arquivoEnv = join(RAIZ, '.env')
if (existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv)

const DESTINO = process.env.BACKUP_DIR || 'D:\\Backups\\RestauranteOS'
const MANTER = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '30', 10) || 30)
const PREFIXO = 'restaurante-os-'

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main() {
  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    console.error('[backup] SUPABASE_DB_URL nao definida (.env). Abortando.')
    process.exit(1)
  }

  const client = new pg.Client({
    connectionString: url,
    // Mesma decisao do migrator: CA do Supabase fixada, verificacao TLS ligada.
    ssl: { ca: await readFile(CAMINHO_CA, 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()

  // Snapshot consistente: todas as tabelas lidas no mesmo instante logico.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

  const { rows: tabelas } = await client.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name`)

  const dump = {
    formato: 'restaurante-os-backup/1',
    gerado_em: new Date().toISOString(),
    banco: new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname,
    migrations: [],
    contagem: {},
    tabelas: {},
  }

  for (const { table_name: t } of tabelas) {
    // to_jsonb no proprio Postgres preserva tipos (numeric, jsonb, timestamptz)
    // sem conversao do driver.
    const { rows } = await client.query(`select to_jsonb(x) as r from public."${t.replace(/"/g, '""')}" x`)
    dump.tabelas[t] = rows.map((l) => l.r)
    dump.contagem[t] = rows.length
  }
  if (dump.tabelas.schema_migrations) {
    dump.migrations = dump.tabelas.schema_migrations
      .map((m) => m.versao)
      .sort()
  }

  await client.query('COMMIT')
  await client.end()

  await mkdir(DESTINO, { recursive: true })
  const caminho = join(DESTINO, `${PREFIXO}${carimbo()}.json.gz`)
  await pipeline(Readable.from([JSON.stringify(dump)]), createGzip({ level: 9 }), createWriteStream(caminho))

  // Confere que o arquivo gravado abre e bate com o que foi lido.
  const pedacos = []
  await pipeline(createReadStream(caminho), createGunzip(), async function* (src) {
    for await (const c of src) pedacos.push(c)
  })
  const relido = JSON.parse(Buffer.concat(pedacos).toString('utf8'))
  for (const [t, n] of Object.entries(dump.contagem)) {
    if ((relido.tabelas[t] || []).length !== n) throw new Error(`verificacao falhou na tabela ${t}`)
  }

  const tamanho = (await stat(caminho)).size
  const linhas = Object.values(dump.contagem).reduce((a, b) => a + b, 0)
  console.log(`[backup] OK: ${caminho}`)
  console.log(`[backup] ${tabelas.length} tabelas, ${linhas} linhas, ${(tamanho / 1024).toFixed(0)} KB (verificado)`)

  // Rotacao: mantem os MANTER mais recentes (nome tem carimbo ordenavel).
  const antigos = (await readdir(DESTINO))
    .filter((f) => f.startsWith(PREFIXO) && f.endsWith('.json.gz'))
    .sort()
    .reverse()
    .slice(MANTER)
  for (const f of antigos) {
    await rm(join(DESTINO, f))
    console.log(`[backup] removido (rotacao, mantendo ${MANTER}): ${f}`)
  }
}

main().catch((e) => {
  console.error(`[backup] FALHOU: ${e.message}`)
  process.exit(1)
})
