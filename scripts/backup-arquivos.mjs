#!/usr/bin/env node
/**
 * Backup dos ARQUIVOS do Supabase Storage (logos, imagens de cardapio).
 * ============================================================================
 * Complementa o `backup-db.mjs`, que so copia as tabelas: os arquivos vivem
 * fora do Postgres e os buckets (`logos`, `cardapios`) foram criados a mao via
 * Admin API — nenhuma migration os recria. Sem este backup, perder o projeto
 * (ou migrar de regiao) perde todas as imagens.
 *
 * Grava em `<BACKUP_DIR>/arquivos-<carimbo>/`:
 *   manifest.json        config de cada bucket (public, limite, mime types)
 *                        + lista de objetos (caminho, mimetype, tamanho)
 *   <bucket>/<caminho>   o arquivo em si
 *
 * Cada download e conferido contra o tamanho registrado no Storage.
 *
 * USO:  yarn backup:arquivos
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = join(AQUI, '..')
const arquivoEnv = join(RAIZ, '.env')
if (existsSync(arquivoEnv)) process.loadEnvFile(arquivoEnv)

const DESTINO = process.env.BACKUP_DIR || 'D:\\Backups\\RestauranteOS'

function carimbo(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main() {
  const { SUPABASE_DB_URL: dbUrl, SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: chave } = process.env
  if (!dbUrl || !apiUrl || !chave) throw new Error('faltam SUPABASE_DB_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env')

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { ca: await readFile(join(RAIZ, 'supabase', 'prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
  })
  await client.connect()
  const { rows: buckets } = await client.query(
    'select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id')
  const { rows: objetos } = await client.query(`
    select bucket_id, name, metadata->>'mimetype' as mimetype, (metadata->>'size')::bigint as tamanho
    from storage.objects order by bucket_id, name`)
  await client.end()

  const pasta = join(DESTINO, `arquivos-${carimbo()}`)
  await mkdir(pasta, { recursive: true })

  let bytes = 0
  for (const o of objetos) {
    const url = `${apiUrl}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${o.name.split('/').map(encodeURIComponent).join('/')}`
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${chave}`, apikey: chave } })
    if (!resp.ok) throw new Error(`download falhou (${resp.status}): ${o.bucket_id}/${o.name}`)
    const conteudo = Buffer.from(await resp.arrayBuffer())
    if (o.tamanho != null && conteudo.length !== Number(o.tamanho)) {
      throw new Error(`tamanho diferente em ${o.bucket_id}/${o.name}: storage=${o.tamanho} baixado=${conteudo.length}`)
    }
    const destino = join(pasta, o.bucket_id, ...o.name.split('/'))
    await mkdir(dirname(destino), { recursive: true })
    await writeFile(destino, conteudo)
    bytes += conteudo.length
  }

  const manifest = {
    formato: 'restaurante-os-arquivos/1',
    gerado_em: new Date().toISOString(),
    origem: apiUrl,
    buckets,
    objetos: objetos.map((o) => ({ ...o, tamanho: o.tamanho == null ? null : Number(o.tamanho) })),
  }
  await writeFile(join(pasta, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Confere que tudo que esta no manifesto existe em disco com o tamanho certo.
  for (const o of manifest.objetos) {
    const s = await stat(join(pasta, o.bucket_id, ...o.name.split('/')))
    if (o.tamanho != null && s.size !== o.tamanho) throw new Error(`verificacao falhou: ${o.bucket_id}/${o.name}`)
  }

  console.log(`[backup:arquivos] OK: ${pasta}`)
  console.log(`[backup:arquivos] ${buckets.length} buckets, ${objetos.length} arquivos, ${(bytes / 1024 / 1024).toFixed(1)} MB (verificado)`)
}

main().catch((e) => {
  console.error(`[backup:arquivos] FALHOU: ${e.message}`)
  process.exit(1)
})
