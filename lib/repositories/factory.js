/**
 * Repository Factory — ponto unico de escolha do backend de persistencia.
 * ============================================================================
 * Fase 7 da migracao MongoDB -> Supabase. Antes desta fase, `route.js`
 * construia os 14 `Mongo*Repository` inline e ainda acessava
 * `db.collection()` diretamente em 3 pontos (indices, seed, webhook_events).
 * Agora ha um unico lugar que decide QUAL implementacao usar, e o Service
 * (route.js) passa a depender so dos contratos de `packages/domain`.
 *
 * Escolha por variavel de ambiente `DATABASE_PROVIDER`:
 *   - `mongo`    (DEFAULT) — comportamento historico, inalterado.
 *   - `supabase` — usa os `Supabase*Repository` validados na Fase 5/6B.
 *
 * O default e deliberadamente `mongo`: ligar o Supabase e uma acao
 * consciente, e voltar atras e so mudar a variavel de novo (sem redeploy de
 * codigo, sem migration reversa). Nao ha modo "hibrido" — misturar os dois
 * backends na mesma requisicao produziria leituras inconsistentes e
 * quebraria as FKs do Postgres.
 */

import { MongoClient } from 'mongodb'

// --- Mongo ---
import { createCategoriaRepository as mongoCategoria } from './mongo/categoriaRepository'
import { createProdutoRepository as mongoProduto } from './mongo/produtoRepository'
import { createClienteRepository as mongoCliente } from './mongo/clienteRepository'
import { createUsuarioRepository as mongoUsuario } from './mongo/usuarioRepository'
import { createTransacaoRepository as mongoTransacao } from './mongo/transacaoRepository'
import { createAuditoriaRepository as mongoAuditoria } from './mongo/auditoriaRepository'
import { createIntegracaoRepository as mongoIntegracao } from './mongo/integracaoRepository'
import { createMesaRepository as mongoMesa } from './mongo/mesaRepository'
import { createConversaRepository as mongoConversa } from './mongo/conversaRepository'
import { createMensagemRepository as mongoMensagem } from './mongo/mensagemRepository'
import { createPedidoRepository as mongoPedido } from './mongo/pedidoRepository'
import { createComandaRepository as mongoComanda } from './mongo/comandaRepository'
import { createPagamentoRepository as mongoPagamento } from './mongo/pagamentoRepository'
import { createEmpresaRepository as mongoEmpresa } from './mongo/empresaRepository'
import { createWebhookEventsRepository as mongoWebhookEvents } from './mongo/webhookEventsRepository'
import { createKdsTokenRepository as mongoKdsToken } from './mongo/kdsTokenRepository'

// --- Supabase ---
import { createCategoriaRepository as sbCategoria } from './supabase/categoriaRepository'
import { createProdutoRepository as sbProduto } from './supabase/produtoRepository'
import { createClienteRepository as sbCliente } from './supabase/clienteRepository'
import { createUsuarioRepository as sbUsuario } from './supabase/usuarioRepository'
import { createTransacaoRepository as sbTransacao } from './supabase/transacaoRepository'
import { createAuditoriaRepository as sbAuditoria } from './supabase/auditoriaRepository'
import { createIntegracaoRepository as sbIntegracao } from './supabase/integracaoRepository'
import { createMesaRepository as sbMesa } from './supabase/mesaRepository'
import { createConversaRepository as sbConversa } from './supabase/conversaRepository'
import { createMensagemRepository as sbMensagem } from './supabase/mensagemRepository'
import { createPedidoRepository as sbPedido } from './supabase/pedidoRepository'
import { createComandaRepository as sbComanda } from './supabase/comandaRepository'
import { createPagamentoRepository as sbPagamento } from './supabase/pagamentoRepository'
import { createEmpresaRepository as sbEmpresa } from './supabase/empresaRepository'
import { createWebhookEventsRepository as sbWebhookEvents } from './supabase/webhookEventsRepository'
import { createKdsTokenRepository as sbKdsToken } from './supabase/kdsTokenRepository'

import { getSupabaseAdmin, isSupabaseConfigured } from '@/lib/integrations/supabase'

export const PROVIDERS = { MONGO: 'mongo', SUPABASE: 'supabase' }

export function getProviderName() {
  const raw = (process.env.DATABASE_PROVIDER || PROVIDERS.MONGO).trim().toLowerCase()
  if (raw !== PROVIDERS.MONGO && raw !== PROVIDERS.SUPABASE) {
    throw new Error(
      `DATABASE_PROVIDER invalido: "${raw}". Valores aceitos: "${PROVIDERS.MONGO}" ou "${PROVIDERS.SUPABASE}".`
    )
  }
  return raw
}

/* ======================== Backend: MongoDB ======================== */

let _mongoClient
let _mongoDb
let _mongoIndexed = false

/**
 * Indices sao best-effort no runtime (igual ao comportamento historico): uma
 * falha aqui nao pode derrubar a requisicao. No backend Supabase este passo
 * nao existe — os indices vem das migrations, versionadas em supabase/.
 */
async function ensureMongoIndexes(database) {
  if (_mongoIndexed) return
  _mongoIndexed = true
  try {
    await database.collection('usuarios').createIndex({ email: 1 }, { unique: true })
    await database.collection('usuarios').createIndex({ empresa_id: 1 })
    for (const c of ['categorias', 'produtos', 'clientes', 'pedidos', 'transacoes', 'auditoria', 'integracoes', 'mesas', 'comandas', 'pagamentos', 'webhook_events', 'conversas', 'mensagens']) {
      await database.collection(c).createIndex({ empresa_id: 1 })
    }
    await database.collection('empresas').createIndex({ slug: 1 }, { unique: true })
  } catch (e) {
    // best-effort, como sempre foi
  }
}

async function getMongoDb() {
  if (!_mongoDb) {
    if (!process.env.MONGO_URL || !process.env.DB_NAME) {
      throw new Error('DATABASE_PROVIDER=mongo exige MONGO_URL e DB_NAME configurados.')
    }
    _mongoClient = new MongoClient(process.env.MONGO_URL)
    await _mongoClient.connect()
    _mongoDb = _mongoClient.db(process.env.DB_NAME)
    await ensureMongoIndexes(_mongoDb)
  }
  return _mongoDb
}

function buildMongoRepositories(database) {
  return {
    provider: PROVIDERS.MONGO,
    categoriaRepo: mongoCategoria(database),
    produtoRepo: mongoProduto(database),
    clienteRepo: mongoCliente(database),
    usuarioRepo: mongoUsuario(database),
    transacaoRepo: mongoTransacao(database),
    auditoriaRepo: mongoAuditoria(database),
    integracaoRepo: mongoIntegracao(database),
    mesaRepo: mongoMesa(database),
    conversaRepo: mongoConversa(database),
    mensagemRepo: mongoMensagem(database),
    pedidoRepo: mongoPedido(database),
    comandaRepo: mongoComanda(database),
    pagamentoRepo: mongoPagamento(database),
    empresaRepo: mongoEmpresa(database),
    webhookEventsRepo: mongoWebhookEvents(database),
    kdsTokenRepo: mongoKdsToken(database),
  }
}

/* ======================== Backend: Supabase ======================== */

function buildSupabaseRepositories(supabase) {
  return {
    provider: PROVIDERS.SUPABASE,
    categoriaRepo: sbCategoria(supabase),
    produtoRepo: sbProduto(supabase),
    clienteRepo: sbCliente(supabase),
    usuarioRepo: sbUsuario(supabase),
    transacaoRepo: sbTransacao(supabase),
    auditoriaRepo: sbAuditoria(supabase),
    integracaoRepo: sbIntegracao(supabase),
    mesaRepo: sbMesa(supabase),
    conversaRepo: sbConversa(supabase),
    mensagemRepo: sbMensagem(supabase),
    pedidoRepo: sbPedido(supabase),
    comandaRepo: sbComanda(supabase),
    pagamentoRepo: sbPagamento(supabase),
    empresaRepo: sbEmpresa(supabase),
    webhookEventsRepo: sbWebhookEvents(supabase),
    kdsTokenRepo: sbKdsToken(supabase),
  }
}

/* ============================== API ============================== */

/**
 * Devolve o conjunto completo de repositories do provider ativo. Unico ponto
 * do sistema que sabe qual backend esta em uso — todo o resto (route.js)
 * fala apenas com os contratos.
 *
 * Nunca faz fallback silencioso: se `DATABASE_PROVIDER=supabase` estiver
 * ligado mas as credenciais faltarem, isso e um erro de configuracao e
 * precisa aparecer, nao virar "voltou pro Mongo sem avisar" (o que
 * significaria gravar dados no banco errado sem ninguem perceber).
 */
export async function getRepositories() {
  const provider = getProviderName()

  if (provider === PROVIDERS.SUPABASE) {
    if (!isSupabaseConfigured()) {
      throw new Error(
        'DATABASE_PROVIDER=supabase exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY configurados.'
      )
    }
    const supabase = await getSupabaseAdmin()
    return buildSupabaseRepositories(supabase)
  }

  const database = await getMongoDb()
  return buildMongoRepositories(database)
}
