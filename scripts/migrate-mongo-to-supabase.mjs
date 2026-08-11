#!/usr/bin/env node
/**
 * Fase 6 — Ferramenta de migração de dados MongoDB → Supabase.
 * ============================================================================
 * NÃO troca o runtime da aplicação, NÃO altera/apaga dados no MongoDB, NÃO
 * toca em app/api/[[...path]]/route.js. Lê diretamente das collections Mongo
 * (não usa os Mongo*Repository — precisa de varredura cross-tenant, que os
 * repositories não expõem) e escreve no Supabase via upsert idempotente por
 * `id` (entidades simples) ou via as RPCs `upsert_pedido_com_itens()` /
 * `upsert_comanda_com_itens()` (migration 0011) para os agregados com itens
 * filhos, que fazem upsert do pai + replace atômico dos filhos.
 *
 * Ordem e regras de transformação: ver docs/plans/PHASE-6-MIGRATION-AUDIT.md
 * (mapeamento completo, ordem validada contra FKs reais, estratégia de ID,
 * transformação de itens sem desconto/subtotal, descarte de
 * comanda.pagamentos[]).
 *
 * Uso:
 *   node scripts/migrate-mongo-to-supabase.mjs [--dry-run] [--empresa=<id>]
 *     [--checkpoint=<arquivo>] [--log=<arquivo>]
 *
 * Variáveis de ambiente:
 *   MONGO_URL, DB_NAME                          — origem (obrigatórias)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY      — destino real (produção)
 *   MIGRATION_TEST_POSTGREST_URL, MIGRATION_TEST_JWT
 *     — override SOMENTE para os testes desta fase contra o PostgREST local
 *       sem Kong (mesmo mecanismo de teste usado nas Fases 4/5). Nunca usar
 *       em produção; se ausentes, o script usa getSupabaseAdmin() normal.
 */

import { MongoClient } from 'mongodb'
import { v5 as uuidv5 } from 'uuid'
import fs from 'fs'

/** Namespace fixo desta ferramenta, só para gerar UUIDs v5 determinísticos
 *  (mesma entrada -> sempre o mesmo id). Não é segredo, não precisa ser
 *  gerado dinamicamente — é só uma âncora fixa para o hash. */
const MIGRATION_UUID_NAMESPACE = '7c2c6f0a-9f2b-4e0a-8f0a-6f3b6b1b7c2c'

// ============================================================================
// CLI / infra
// ============================================================================

function parseArgs(argv) {
  const args = { dryRun: false, empresa: null, checkpoint: null, log: null }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a.startsWith('--empresa=')) args.empresa = a.slice('--empresa='.length)
    else if (a.startsWith('--checkpoint=')) args.checkpoint = a.slice('--checkpoint='.length)
    else if (a.startsWith('--log=')) args.log = a.slice('--log='.length)
  }
  return args
}

function makeLogger(logPath) {
  const stream = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null
  return function log(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event })
    console.log(line)
    if (stream) stream.write(line + '\n')
  }
}

function loadCheckpoint(checkpointPath) {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) return { done: {}, empresasCompletas: [] }
  return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
}

function saveCheckpoint(checkpointPath, state) {
  if (!checkpointPath) return
  fs.writeFileSync(checkpointPath, JSON.stringify(state, null, 2))
}

async function getSupabaseClient() {
  if (process.env.MIGRATION_TEST_POSTGREST_URL) {
    const { PostgrestClient } = await import('@supabase/postgrest-js')
    return new PostgrestClient(process.env.MIGRATION_TEST_POSTGREST_URL, {
      headers: { Authorization: `Bearer ${process.env.MIGRATION_TEST_JWT}` },
    })
  }
  const { getSupabaseAdmin, isSupabaseConfigured } = await import('../lib/integrations/supabase.js')
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase não configurado (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes). Defina as variáveis ou use MIGRATION_TEST_POSTGREST_URL/MIGRATION_TEST_JWT apenas para teste local.')
  }
  return getSupabaseAdmin()
}

async function getMongoDb() {
  if (!process.env.MONGO_URL || !process.env.DB_NAME) {
    throw new Error('MONGO_URL/DB_NAME ausentes — necessários para ler a origem MongoDB.')
  }
  const client = new MongoClient(process.env.MONGO_URL)
  await client.connect()
  return { mongoClient: client, db: client.db(process.env.DB_NAME) }
}

// ============================================================================
// Helpers de transformação
// ============================================================================

/** Só inclui a chave se definida no doc de origem — nunca inventa valor,
 *  deixa o DEFAULT da coluna Postgres se aplicar quando o campo não existe
 *  no Mongo (mesmo comportamento de um INSERT que omite a coluna).
 *
 *  Achado real ao testar contra o PostgREST local: um upsert em lote (várias
 *  linhas na mesma chamada) NÃO aplica o DEFAULT da coluna por linha — se
 *  uma linha do lote tem `updated_at` (documento já editado no Mongo, que só
 *  ganha `updated_at` no primeiro `$set` de update) e outra não (documento
 *  nunca editado desde a criação), o PostgREST grava NULL nas linhas sem o
 *  campo em vez de aplicar o DEFAULT — violando `not null`. Não é um bug de
 *  igual comportamento ao INSERT de uma linha só. Correção: `updated_at`
 *  ausente cai para `created_at` (mesmo valor que a linha teria logo após
 *  ser criada e nunca editada — não é um valor inventado, é o próprio dado
 *  já existente no documento). */
function pick(doc, keys) {
  const row = {}
  for (const k of keys) {
    if (doc[k] !== undefined) row[k] = doc[k] === null ? null : (doc[k] instanceof Date ? doc[k].toISOString() : doc[k])
  }
  if (keys.includes('updated_at') && row.updated_at === undefined && row.created_at !== undefined) {
    row.updated_at = row.created_at
  }
  return row
}

const ENTITY_COLUMNS = {
  empresas: ['id', 'nome', 'slug', 'plano', 'telefone', 'endereco', 'moeda', 'config', 'ativo', 'created_at', 'updated_at', 'nome_comercial', 'cnpj', 'whatsapp', 'email', 'logo', 'horario_funcionamento'],
  usuarios: ['id', 'empresa_id', 'nome', 'email', 'papel', 'ativo', 'created_at', 'updated_at', 'senha_hash'],
  categorias: ['id', 'empresa_id', 'nome', 'ordem', 'ativo', 'created_at', 'updated_at'],
  produtos: ['id', 'empresa_id', 'categoria_id', 'nome', 'descricao', 'preco', 'imagem', 'disponivel', 'ativo', 'created_at', 'updated_at'],
  clientes: ['id', 'empresa_id', 'nome', 'telefone', 'email', 'endereco', 'observacoes', 'total_pedidos', 'total_gasto', 'created_at', 'updated_at'],
  mesas: ['id', 'empresa_id', 'numero', 'nome', 'capacidade', 'status', 'ativo', 'created_at', 'updated_at'], // comanda_id tratado à parte (2 passadas, §2 da auditoria)
  pagamentos: ['id', 'empresa_id', 'comanda_id', 'pedido_id', 'metodo', 'valor', 'status', 'provider', 'provider_payment_id', 'external_reference', 'idempotency_key', 'qr_code', 'qr_code_base64', 'ticket_url', 'created_at', 'updated_at'],
  transacoes: ['id', 'empresa_id', 'tipo', 'categoria', 'descricao', 'valor', 'pedido_id', 'comanda_id', 'data', 'created_at'],
  integracoes: ['id', 'empresa_id', 'tipo', 'config', 'status', 'created_at', 'updated_at'],
  conversas: ['id', 'empresa_id', 'cliente_id', 'contato_nome', 'contato_numero', 'status', 'ultima_mensagem', 'ultima_mensagem_em', 'nao_lidas', 'operador_id', 'pedido_ativo_id', 'created_at', 'updated_at'],
  mensagens: ['id', 'empresa_id', 'conversa_id', 'direcao', 'tipo', 'texto', 'media_url', 'from_me', 'status', 'provider_message_id', 'operador_id', 'created_at'],
  auditoria: ['id', 'empresa_id', 'usuario_id', 'usuario_nome', 'acao', 'entidade', 'entidade_id', 'dados', 'created_at'],
}

/** Transformação determinística de item embutido (pedido.itens[] /
 *  comanda.itens[]) — regra documentada em §4 da auditoria: nenhum dos dois
 *  tem `desconto`/`subtotal` no Mongo real; `desconto=0` é o valor neutro,
 *  `subtotal = preco*quantidade - desconto` é a mesma fórmula que o Service
 *  já soma em memória, não uma regra nova. */
function transformItem(raw, stats, parentId, index) {
  let id = raw.id
  if (id === undefined || id === null) {
    // Determinístico (UUID v5) em vez de aleatório: reexecutar a migração
    // com o mesmo documento de origem gera exatamente o mesmo id sintético
    // (idempotência real no nível do item, não só na contagem final).
    id = uuidv5(`${parentId}:${index}`, MIGRATION_UUID_NAMESPACE)
    stats.itensIdSintetizado++
  }
  let desconto = raw.desconto
  if (desconto === undefined || desconto === null) { desconto = 0; stats.itensDescontoDefault++ }
  let subtotal = raw.subtotal
  if (subtotal === undefined || subtotal === null) {
    subtotal = Number(raw.preco || 0) * Number(raw.quantidade || 0) - Number(desconto)
    stats.itensSubtotalCalculado++
  }
  return {
    id,
    produto_id: raw.produto_id ?? null,
    nome: raw.nome,
    preco: raw.preco,
    quantidade: raw.quantidade,
    desconto,
    observacao: raw.observacao ?? '',
    subtotal,
    ...(raw.operador_id !== undefined ? { operador_id: raw.operador_id } : {}),
    ...(raw.operador_nome !== undefined ? { operador_nome: raw.operador_nome } : {}),
    created_at: (raw.created_at instanceof Date ? raw.created_at.toISOString() : raw.created_at) ?? new Date().toISOString(),
  }
}

// ============================================================================
// Upsert genérico (entidades simples, sem itens filhos)
// ============================================================================

async function upsertSimple(supabase, table, rows, log, empresaId) {
  if (rows.length === 0) return { count: 0 }
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' })
    if (error) {
      log({ level: 'error', empresa_id: empresaId, tabela: table, evento: 'upsert_falhou', erro: error.message, detalhes: error.details })
      throw new Error(`Falha ao migrar ${table} (empresa ${empresaId}): ${error.message}`)
    }
  }
  return { count: rows.length }
}

// ============================================================================
// Migração por coleção
// ============================================================================

async function migrateEmpresas(db, supabase, log, dryRun, empresaFiltro) {
  const query = empresaFiltro ? { id: empresaFiltro } : {}
  const docs = await db.collection('empresas').find(query).toArray()
  const rows = docs.map((d) => pick(d, ENTITY_COLUMNS.empresas))
  log({ level: 'info', evento: 'descoberta', tabela: 'empresas', contagem_mongo: docs.length })
  if (!dryRun) await upsertSimple(supabase, 'empresas', rows, log, null)
  log({ level: 'info', evento: dryRun ? 'dry_run' : 'migrado', tabela: 'empresas', contagem: rows.length })
  return docs
}

async function migrateSimpleCollection(db, supabase, log, dryRun, empresaId, collectionName, tableName = collectionName) {
  const docs = await db.collection(collectionName).find({ empresa_id: empresaId }).toArray()
  const rows = docs.map((d) => pick(d, ENTITY_COLUMNS[tableName]))
  log({ level: 'info', empresa_id: empresaId, evento: 'descoberta', tabela: tableName, contagem_mongo: docs.length })
  if (!dryRun) await upsertSimple(supabase, tableName, rows, log, empresaId)
  log({ level: 'info', empresa_id: empresaId, evento: dryRun ? 'dry_run' : 'migrado', tabela: tableName, contagem: rows.length })
  return docs.length
}

async function migrateMesasPassA(db, supabase, log, dryRun, empresaId) {
  const docs = await db.collection('mesas').find({ empresa_id: empresaId }).toArray()
  const rows = docs.map((d) => pick(d, ENTITY_COLUMNS.mesas))
  log({ level: 'info', empresa_id: empresaId, evento: 'descoberta', tabela: 'mesas', contagem_mongo: docs.length })
  if (!dryRun) await upsertSimple(supabase, 'mesas', rows, log, empresaId)
  log({ level: 'info', empresa_id: empresaId, evento: dryRun ? 'dry_run' : 'migrado', tabela: 'mesas (passo A, sem comanda_id)', contagem: rows.length })
  return docs
}

/** Passo B (§2 da auditoria): fecha a referência mesas.comanda_id agora que
 *  as comandas já existem — evita a dependência circular mesas⇄comandas. */
async function migrateMesasPassB(mesasDocs, supabase, log, dryRun, empresaId) {
  const comMesaId = mesasDocs.filter((m) => m.comanda_id)
  log({ level: 'info', empresa_id: empresaId, evento: 'descoberta', tabela: 'mesas.comanda_id', contagem_mongo: comMesaId.length })
  if (!dryRun) {
    for (const m of comMesaId) {
      const { error } = await supabase.from('mesas').update({ comanda_id: m.comanda_id }).eq('id', m.id).eq('empresa_id', empresaId)
      if (error) {
        log({ level: 'error', empresa_id: empresaId, tabela: 'mesas', evento: 'update_comanda_id_falhou', mesa_id: m.id, erro: error.message })
        throw new Error(`Falha ao vincular mesas.comanda_id (empresa ${empresaId}, mesa ${m.id}): ${error.message}`)
      }
    }
  }
  log({ level: 'info', empresa_id: empresaId, evento: dryRun ? 'dry_run' : 'migrado', tabela: 'mesas (passo B, comanda_id)', contagem: comMesaId.length })
}

async function migratePedidos(db, supabase, log, dryRun, empresaId, stats) {
  const docs = await db.collection('pedidos').find({ empresa_id: empresaId }).toArray()
  log({ level: 'info', empresa_id: empresaId, evento: 'descoberta', tabela: 'pedidos', contagem_mongo: docs.length })
  if (!dryRun) {
    for (const doc of docs) {
      const itens = (doc.itens || []).map((it, idx) => transformItem(it, stats, doc.id, idx))
      const pPedido = pick(doc, ['id', 'empresa_id', 'numero', 'cliente_id', 'cliente_nome', 'tipo', 'pagamento', 'status', 'observacoes', 'total', 'comanda_id', 'created_at', 'updated_at'])
      const { error } = await supabase.rpc('upsert_pedido_com_itens', { p_pedido: pPedido, p_itens: itens })
      if (error) {
        log({ level: 'error', empresa_id: empresaId, tabela: 'pedidos', evento: 'rpc_falhou', pedido_id: doc.id, erro: error.message, detalhes: error.details })
        throw new Error(`Falha ao migrar pedido ${doc.id} (empresa ${empresaId}): ${error.message}`)
      }
    }
  } else {
    for (const doc of docs) (doc.itens || []).forEach((it, idx) => transformItem(it, stats, doc.id, idx))
  }
  log({ level: 'info', empresa_id: empresaId, evento: dryRun ? 'dry_run' : 'migrado', tabela: 'pedidos', contagem: docs.length })
  return docs.length
}

async function migrateComandas(db, supabase, log, dryRun, empresaId, stats) {
  const docs = await db.collection('comandas').find({ empresa_id: empresaId }).toArray()
  log({ level: 'info', empresa_id: empresaId, evento: 'descoberta', tabela: 'comandas', contagem_mongo: docs.length })
  let pagamentosDivergentes = 0
  if (!dryRun) {
    for (const doc of docs) {
      const itens = (doc.itens || []).map((it, idx) => transformItem(it, stats, doc.id, idx))
      // comanda.pagamentos[] é descartado (§5 da auditoria) — fonte real é a
      // tabela `pagamentos`, migrada separadamente (item 9 do mapeamento).
      const pComanda = pick(doc, ['id', 'empresa_id', 'mesa_id', 'mesa_nome', 'cliente_id', 'cliente_nome', 'pessoas', 'status', 'desconto', 'desconto_tipo', 'taxa_servico_percent', 'operador_id', 'operador_nome', 'subtotal', 'desconto_valor', 'taxa_valor', 'total', 'pago', 'restante', 'aberta_em', 'fechada_em', 'created_at', 'updated_at'])
      const { error } = await supabase.rpc('upsert_comanda_com_itens', { p_comanda: pComanda, p_itens: itens })
      if (error) {
        log({ level: 'error', empresa_id: empresaId, tabela: 'comandas', evento: 'rpc_falhou', comanda_id: doc.id, erro: error.message, detalhes: error.details })
        throw new Error(`Falha ao migrar comanda ${doc.id} (empresa ${empresaId}): ${error.message}`)
      }
      if (Array.isArray(doc.pagamentos)) pagamentosDivergentes += doc.pagamentos.length
    }
  } else {
    for (const doc of docs) {
      (doc.itens || []).forEach((it, idx) => transformItem(it, stats, doc.id, idx))
      if (Array.isArray(doc.pagamentos)) pagamentosDivergentes += doc.pagamentos.length
    }
  }
  log({ level: 'info', empresa_id: empresaId, evento: dryRun ? 'dry_run' : 'migrado', tabela: 'comandas', contagem: docs.length, pagamentos_embutidos_descartados: pagamentosDivergentes })
  return docs.length
}

// ============================================================================
// Orquestração
// ============================================================================

// Ordem corrigida durante o teste real desta fase: `pedidos.comanda_id`
// (migration 0012, corrigida nesta mesma sessão) cria uma FK de pedidos para
// comandas que NÃO existia quando a ordem original da auditoria foi escrita
// — `comandas` precisa vir ANTES de `pedidos` agora (o inverso do que
// §2 do audit doc dizia antes desta correção; doc atualizado em conjunto).
const STEPS_POR_EMPRESA = [
  'usuarios', 'categorias', 'produtos', 'clientes', 'mesas_a',
  'comandas', 'pedidos', 'mesas_b',
  'pagamentos', 'transacoes', 'integracoes', 'conversas', 'mensagens', 'auditoria',
]

async function migrateEmpresa(db, supabase, log, dryRun, empresaId, checkpoint, checkpointPath, stats) {
  const key = (step) => `${empresaId}:${step}`
  let mesasDocs = null

  for (const step of STEPS_POR_EMPRESA) {
    if (!dryRun && checkpoint.done[key(step)]) {
      log({ level: 'info', empresa_id: empresaId, evento: 'checkpoint_skip', passo: step })
      continue
    }

    switch (step) {
      case 'usuarios': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'usuarios'); break
      case 'categorias': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'categorias'); break
      case 'produtos': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'produtos'); break
      case 'clientes': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'clientes'); break
      case 'mesas_a': mesasDocs = await migrateMesasPassA(db, supabase, log, dryRun, empresaId); break
      case 'pedidos': await migratePedidos(db, supabase, log, dryRun, empresaId, stats); break
      case 'comandas': await migrateComandas(db, supabase, log, dryRun, empresaId, stats); break
      case 'mesas_b':
        if (mesasDocs === null) mesasDocs = await db.collection('mesas').find({ empresa_id: empresaId }).toArray()
        await migrateMesasPassB(mesasDocs, supabase, log, dryRun, empresaId)
        break
      case 'pagamentos': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'pagamentos'); break
      case 'transacoes': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'transacoes'); break
      case 'integracoes': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'integracoes'); break
      case 'conversas': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'conversas'); break
      case 'mensagens': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'mensagens'); break
      case 'auditoria': await migrateSimpleCollection(db, supabase, log, dryRun, empresaId, 'auditoria'); break
    }

    if (!dryRun) {
      checkpoint.done[key(step)] = true
      saveCheckpoint(checkpointPath, checkpoint)
    }
  }

  if (!dryRun && !checkpoint.empresasCompletas.includes(empresaId)) {
    checkpoint.empresasCompletas.push(empresaId)
    saveCheckpoint(checkpointPath, checkpoint)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = makeLogger(args.log)
  const checkpoint = loadCheckpoint(args.checkpoint)
  const stats = { itensIdSintetizado: 0, itensDescontoDefault: 0, itensSubtotalCalculado: 0 }

  log({ level: 'info', evento: 'inicio', dry_run: args.dryRun, empresa_filtro: args.empresa, checkpoint: args.checkpoint })

  const { mongoClient, db } = await getMongoDb()
  const supabase = await getSupabaseClient()

  try {
    const empresas = await migrateEmpresas(db, supabase, log, args.dryRun, args.empresa)

    if (empresas.length === 0) {
      log({ level: 'warn', evento: 'nenhuma_empresa', mensagem: 'Nenhuma empresa encontrada no MongoDB — nada a migrar.' })
    }

    for (const empresa of empresas) {
      log({ level: 'info', evento: 'empresa_inicio', empresa_id: empresa.id, empresa_slug: empresa.slug })
      await migrateEmpresa(db, supabase, log, args.dryRun, empresa.id, checkpoint, args.checkpoint, stats)
      log({ level: 'info', evento: 'empresa_fim', empresa_id: empresa.id })
    }

    if (!args.dryRun && empresas.length > 0) {
      const { error } = await supabase.rpc('resync_pedido_contadores', {})
      if (error) throw new Error(`Falha ao recalcular pedido_contadores: ${error.message}`)
      log({ level: 'info', evento: 'resync_pedido_contadores', status: 'ok' })
    }

    log({
      level: 'info', evento: 'fim', dry_run: args.dryRun, empresas_migradas: empresas.length,
      itens_id_sintetizado: stats.itensIdSintetizado,
      itens_desconto_default: stats.itensDescontoDefault,
      itens_subtotal_calculado: stats.itensSubtotalCalculado,
    })
  } finally {
    await mongoClient.close()
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', evento: 'erro_fatal', erro: err.message }))
  process.exitCode = 1
})
