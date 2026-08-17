#!/usr/bin/env node
/**
 * Runner de migrations do Restaurant OS.
 * ============================================================================
 * POR QUE ISTO EXISTE
 *
 * Ate 2026-08-18 as migrations eram aplicadas **na mao**, via
 * `docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" < arquivo.sql`.
 * O EasyPanel faz auto-deploy do CODIGO no push, mas nunca soube de schema.
 * Resultado: `0019_estoque`, `0020_custo` e `0021_cardapio_imagem` ficaram
 * commitadas e "concluidas" por dias enquanto o banco de producao nao tinha
 * as colunas — Estoque e CMV quebrados em producao sem ninguem perceber, ate
 * o dono esbarrar no erro subindo a imagem do cardapio.
 *
 * Este script roda no boot do container (ver `docker/entrypoint.sh`), antes do
 * servidor subir. Schema errado passa a ser impossivel de ignorar.
 *
 * ----------------------------------------------------------------------------
 * DECISOES QUE NAO SAO OBVIAS
 *
 * 1. **Arquivo inteiro numa query so, nunca split por `;`.** Oito migrations
 *    tem corpo de funcao com `$$ ... $$`, e o `;` dentro do corpo nao termina
 *    comando. Split ingenuo quebraria exatamente as migrations mais criticas
 *    (as funcoes atomicas de pedido/comanda).
 *
 * 2. **Tabela de controle, nao "roda tudo sempre".** `0018_caixa.sql` usa
 *    `CREATE TABLE` sem `IF NOT EXISTS` — reexecutar quebra. A maioria das
 *    outras e idempotente, mas basta uma nao ser.
 *
 * 3. **Baseline para banco pre-existente.** Producao ja tinha as 21 migrations
 *    aplicadas na mao quando este runner nasceu. Se existe schema (`empresas`)
 *    mas nao existe controle, marcamos o que ja existe como aplicado em vez de
 *    tentar reexecutar. Banco vazio roda tudo do zero, normalmente.
 *
 * 4. **Advisory lock.** Dois containers subindo juntos (deploy, restart, scale)
 *    tentariam migrar em paralelo. O lock serializa; o segundo encontra tudo
 *    aplicado e segue.
 *
 * 5. **Falha em migration derruba o boot (exit != 0).** E deliberado: subir a
 *    app com schema errado foi exatamente o bug que originou este arquivo.
 *    Excecao unica: falta de `SUPABASE_DB_URL` apenas AVISA e segue, para que
 *    introduzir este runner nao derrube um deploy que ainda nao tem a variavel
 *    configurada no painel.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const AQUI = dirname(fileURLToPath(import.meta.url))
const DIR_MIGRATIONS = join(AQUI, '..', 'supabase', 'migrations')

/**
 * CA raiz do Supabase ("Supabase Root 2021 CA"), fixada no repositorio.
 *
 * O pooler nao usa CA publica: apresenta cadeia propria, entao a validacao
 * padrao do Node falha com "self-signed certificate in certificate chain".
 * A saida preguicosa seria `rejectUnauthorized: false` — que desliga a
 * validacao inteira e aceitaria QUALQUER certificado, inclusive de um
 * interceptador. Esta conexao carrega a senha do banco e todo o dado dos
 * clientes; nao e lugar para isso.
 *
 * Este arquivo foi obtido do endpoint oficial de download do Supabase (sobre
 * HTTPS validado por CA publica) e conferido contra a raiz que o servidor
 * apresenta — fingerprint SHA-256 identico nos dois:
 *   80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
 * Com a CA fixada, a verificacao continua LIGADA e so esta cadeia e aceita.
 */
const CAMINHO_CA = join(AQUI, '..', 'supabase', 'prod-ca-2021.crt')

// Chave arbitraria porem estavel: dois processos so se serializam se usarem o
// mesmo numero. Nao pode ser derivada de hash de string em runtime sem cuidado
// (hashtext varia entre versoes), entao e uma constante literal.
const LOCK_ID = 8_150_318_240_921

// `--dry-run` (ou MIGRATE_DRY_RUN=1) inspeciona e relata sem escrever nada:
// nem baseline, nem migration, nem tabela de controle. Existe para que dar um
// deploy nao seja a primeira vez que alguem descobre o que o runner vai fazer.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.MIGRATE_DRY_RUN === '1'

const log = (msg) => console.log(`[migrate]${DRY_RUN ? ' (dry-run)' : ''} ${msg}`)
const warn = (msg) => console.warn(`[migrate] AVISO: ${msg}`)

const checksum = (conteudo) => createHash('sha256').update(conteudo).digest('hex').slice(0, 16)

async function listarMigrations() {
  const arquivos = (await readdir(DIR_MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    // Ordem lexicografica funciona porque os nomes sao zero-padded (0001..0021)
    // e o padrao esta documentado no HANDOFF. Um dia com 10000 migrations isso
    // quebra; ate la, e o esquema mais simples que funciona.
    .sort()

  return Promise.all(
    arquivos.map(async (nome) => {
      const sql = await readFile(join(DIR_MIGRATIONS, nome), 'utf8')
      return { versao: nome.replace(/\.sql$/, ''), nome, sql, checksum: checksum(sql) }
    })
  )
}

async function garantirTabelaControle(client) {
  if (DRY_RUN) return
  await client.query(`
    create table if not exists public.schema_migrations (
      versao      text primary key,
      checksum    text        not null,
      aplicada_em timestamptz not null default now()
    )
  `)
}

/**
 * Banco que ja foi migrado na mao (producao, ate 2026-08-18) tem schema mas nao
 * tem controle. Reexecutar 0018 ali quebraria. Detectamos pelo `empresas`, que
 * nasce na 0001 e existe em qualquer banco nao-vazio deste projeto.
 */
async function precisaBaseline(client) {
  const { rows } = await client.query(`select to_regclass('public.empresas') is not null as existe`)
  return rows[0]?.existe === true
}

async function versoesAplicadas(client) {
  const { rows } = await client.query('select versao, checksum from public.schema_migrations')
  return new Map(rows.map((r) => [r.versao, r.checksum]))
}

async function main() {
  const provider = (process.env.DATABASE_PROVIDER || 'supabase').toLowerCase()
  if (provider !== 'supabase') {
    log(`DATABASE_PROVIDER=${provider}: estas migrations sao do Postgres/Supabase. Nada a fazer.`)
    return
  }

  const connectionString = process.env.SUPABASE_DB_URL
  if (!connectionString) {
    // Nao derruba o boot: ver decisao 5 no cabecalho.
    warn('SUPABASE_DB_URL nao definida — migrations NAO foram verificadas.')
    warn('O schema do banco pode estar defasado em relacao ao codigo desta versao.')
    warn('Defina SUPABASE_DB_URL nas variaveis de ambiente para ativar a verificacao.')
    return
  }

  const migrations = await listarMigrations()
  log(`${migrations.length} migrations no repositorio.`)

  // Verificacao TLS LIGADA contra a CA fixada (ver comentario em CAMINHO_CA).
  const ca = await readFile(CAMINHO_CA, 'utf8')

  const client = new pg.Client({
    connectionString,
    ssl: {
      ca,
      rejectUnauthorized: true,
      // O certificado do pooler e curinga (`*.pooler.supabase.com`) e o Node
      // casa isso corretamente com o host da connection string.
      servername: new URL(connectionString).hostname,
    },
    // Boot travado esperando banco e pior que boot que falha com mensagem.
    connectionTimeoutMillis: 30_000,
    statement_timeout: 120_000,
  })

  await client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID])
    try {
      const baseline = !(await client.query(
        `select to_regclass('public.schema_migrations') is not null as existe`
      )).rows[0].existe && (await precisaBaseline(client))

      await garantirTabelaControle(client)

      if (baseline) {
        log('Banco com schema pre-existente e sem tabela de controle.')
        log('Registrando as migrations atuais como ja aplicadas (baseline).')
        if (DRY_RUN) {
          log(`Marcaria ${migrations.length} migrations como aplicadas, sem executar nenhuma:`)
          for (const m of migrations) log(`  - ${m.versao}`)
          log('Nada foi escrito no banco.')
          return
        }
        for (const m of migrations) {
          await client.query(
            `insert into public.schema_migrations (versao, checksum) values ($1, $2)
             on conflict (versao) do nothing`,
            [m.versao, m.checksum]
          )
        }
        log(`Baseline concluida: ${migrations.length} migrations marcadas como aplicadas.`)
        return
      }

      const aplicadas = await versoesAplicadas(client)
      const pendentes = migrations.filter((m) => !aplicadas.has(m.versao))

      // Checksum divergente = arquivo ja aplicado foi editado depois. Nao e
      // fatal (o banco ja tem o efeito da versao antiga), mas e sempre um
      // sinal de que alguem mexeu em historia — vale gritar.
      for (const m of migrations) {
        const anterior = aplicadas.get(m.versao)
        if (anterior && anterior !== m.checksum) {
          warn(`${m.nome} mudou desde que foi aplicada (checksum ${anterior} -> ${m.checksum}).`)
          warn('Migrations ja aplicadas deveriam ser imutaveis: crie uma nova em vez de editar.')
        }
      }

      if (pendentes.length === 0) {
        log('Schema em dia — nenhuma migration pendente.')
        return
      }

      log(`${pendentes.length} migration(s) pendente(s): ${pendentes.map((m) => m.versao).join(', ')}`)

      if (DRY_RUN) {
        log('Aplicaria, nesta ordem:')
        for (const m of pendentes) log(`  - ${m.nome}`)
        log('Nada foi escrito no banco.')
        return
      }

      for (const m of pendentes) {
        log(`aplicando ${m.nome} ...`)
        // Transacao por migration: falha no meio nao deixa a migration pela
        // metade, e as anteriores permanecem aplicadas e registradas.
        await client.query('begin')
        try {
          await client.query(m.sql)
          await client.query(
            'insert into public.schema_migrations (versao, checksum) values ($1, $2)',
            [m.versao, m.checksum]
          )
          await client.query('commit')
          log(`${m.nome} OK`)
        } catch (e) {
          await client.query('rollback').catch(() => {})
          throw new Error(`falha em ${m.nome}: ${e.message}`)
        }
      }

      // Sem isto o PostgREST continua servindo o schema antigo em cache e a
      // coluna recem-criada responde "could not find the column ... in the
      // schema cache" — exatamente o erro que o dono viu em producao.
      await client.query(`notify pgrst, 'reload schema'`)
      log('PostgREST notificado para recarregar o schema.')
      log(`${pendentes.length} migration(s) aplicada(s) com sucesso.`)
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error(`[migrate] ERRO: ${e.message}`)
  console.error('[migrate] O servidor NAO vai subir: schema desalinhado com o codigo')
  console.error('[migrate] causa mais dano em silencio do que um deploy que falha alto.')
  process.exit(1)
})
