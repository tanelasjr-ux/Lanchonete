/**
 * Restaurant OS - API Layer (Next.js Route Handler / catch-all)
 * ============================================================================
 * Arquitetura em camadas (Clean Architecture aplicada ao runtime Next.js):
 *   - Infra      : conexao MongoDB (adaptador default do Repository Pattern)
 *   - Repository : acesso a dados escopado por empresa_id (multitenancy)
 *   - Service    : regras de negocio, auditoria, disparo de eventos
 *   - Controller : dispatch HTTP -> service
 *
 * Multitenancy: TODA entidade carrega empresa_id. Toda query autenticada e
 * escopada pelo empresa_id extraido do token (RLS em nivel de aplicacao,
 * espelhando as policies RLS do Supabase entregues em /supabase).
 *
 * Persistencia desacoplada: hoje roda sobre MongoDB. Ao configurar Supabase
 * (SUPABASE_URL/KEYS) o provider em lib/integrations/supabase fica disponivel.
 */

import { MongoClient } from 'mongodb'
import { v4 as uuidv4 } from 'uuid'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { fetchInstanceStatus } from '@/lib/integrations/evolution'
import { triggerN8nEvent, testN8nConnection } from '@/lib/integrations/n8n'
import { supabaseProviderStatus } from '@/lib/integrations/supabase'
import { getPaymentProvider, isGatewayConfigured, PAYMENT_METHODS, PAYMENT_GATEWAYS } from '@/lib/integrations/payments/provider'

/* ============================ INFRA: MongoDB ============================= */
let client
let db
async function getDb() {
  if (!db) {
    client = new MongoClient(process.env.MONGO_URL)
    await client.connect()
    db = client.db(process.env.DB_NAME)
    await ensureIndexes(db)
  }
  return db
}

let _indexed = false
async function ensureIndexes(database) {
  if (_indexed) return
  _indexed = true
  try {
    await database.collection('usuarios').createIndex({ email: 1 }, { unique: true })
    await database.collection('usuarios').createIndex({ empresa_id: 1 })
    for (const c of ['categorias', 'produtos', 'clientes', 'pedidos', 'transacoes', 'auditoria', 'integracoes', 'mesas', 'comandas', 'pagamentos', 'webhook_events']) {
      await database.collection(c).createIndex({ empresa_id: 1 })
    }
    await database.collection('empresas').createIndex({ slug: 1 }, { unique: true })
  } catch (e) {
    // indices sao best-effort no runtime
  }
}

/* ============================ AUTH HELPERS ============================== */
const JWT_SECRET = process.env.JWT_SECRET || 'ros_dev_secret'
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}
function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }))
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}
function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.')
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
    if (sig !== expected) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':')
    const h = crypto.scryptSync(pw, salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))
  } catch {
    return false
  }
}

/* ============================ RBAC / PAPEIS ============================= */
const ROLES = {
  OWNER: { label: 'Proprietario', level: 100 },
  ADMIN: { label: 'Administrador', level: 80 },
  GERENTE: { label: 'Gerente', level: 60 },
  ATENDENTE: { label: 'Atendente', level: 40 },
  COZINHA: { label: 'Cozinha', level: 20 },
}
const PERMISSIONS = {
  OWNER: ['*'],
  ADMIN: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'mesas', 'financeiro', 'usuarios', 'empresa', 'auditoria', 'integracoes', 'pagamentos'],
  GERENTE: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'mesas', 'financeiro', 'pagamentos'],
  ATENDENTE: ['dashboard', 'clientes', 'pedidos', 'mesas', 'pagamentos'],
  COZINHA: ['dashboard', 'pedidos'],
}
function can(papel, modulo) {
  const perms = PERMISSIONS[papel] || []
  return perms.includes('*') || perms.includes(modulo)
}

/* ============================ HTTP HELPERS ============================= */
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', process.env.CORS_ORIGINS || '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.headers.set('Access-Control-Allow-Credentials', 'true')
  return res
}
function json(data, status = 200) {
  return cors(NextResponse.json(data, { status }))
}
function err(message, status = 400) {
  return json({ error: message }, status)
}
async function auth(request) {
  const header = request.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  return verifyToken(token)
}

/* ============================ AUDITORIA ============================= */
async function audit(database, ctx, acao, entidade, entidade_id, dados = {}) {
  try {
    await database.collection('auditoria').insertOne({
      id: uuidv4(),
      empresa_id: ctx.empresa_id,
      usuario_id: ctx.usuario_id,
      usuario_nome: ctx.nome || null,
      acao,
      entidade,
      entidade_id: entidade_id || null,
      dados,
      created_at: new Date(),
    })
  } catch {
    /* auditoria nunca deve quebrar o fluxo principal */
  }
}

/* ============================ EVENTOS (n8n) ============================= */
async function emitEvent(database, ctx, event, payload) {
  try {
    const integ = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'n8n' })
    await triggerN8nEvent(integ?.config || {}, event, { empresa_id: ctx.empresa_id, ...payload })
  } catch {
    /* fire-and-forget */
  }
}

const clean = (doc) => {
  if (!doc) return doc
  const { _id, senha_hash, ...rest } = doc
  return rest
}
const slugify = (s) =>
  s.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100
const padMesa = (n) => String(n).padStart(2, '0')

/**
 * Recalcula os totais de uma comanda a partir dos itens (lancamentos),
 * desconto e taxa de servico. Fonte unica de verdade para os valores.
 */
function computeComanda(comanda) {
  const subtotal = (comanda.itens || []).reduce((s, it) => s + Number(it.preco) * Number(it.quantidade || 1), 0)
  let descontoValor = 0
  if (comanda.desconto_tipo === 'percent') descontoValor = subtotal * (Number(comanda.desconto || 0) / 100)
  else descontoValor = Number(comanda.desconto || 0)
  descontoValor = Math.min(descontoValor, subtotal)
  const base = subtotal - descontoValor
  const taxaValor = base * (Number(comanda.taxa_servico_percent || 0) / 100)
  const total = base + taxaValor
  const pago = (comanda.pagamentos || []).filter((p) => p.status === 'approved').reduce((s, p) => s + Number(p.valor), 0)
  return {
    subtotal: round2(subtotal),
    desconto_valor: round2(descontoValor),
    taxa_valor: round2(taxaValor),
    total: round2(total),
    pago: round2(pago),
    restante: round2(total - pago),
  }
}
const MESA_STATUS = ['livre', 'ocupada', 'aguardando_pagamento', 'reservada']

/* ============================ SEED (demo) ============================= */
async function seedEmpresa(database, empresa_id, ctx) {
  const now = Date.now()
  const cats = [
    { nome: 'Entradas', ordem: 1 },
    { nome: 'Pratos Principais', ordem: 2 },
    { nome: 'Bebidas', ordem: 3 },
    { nome: 'Sobremesas', ordem: 4 },
  ].map((c) => ({ id: uuidv4(), empresa_id, ...c, ativo: true, created_at: new Date() }))
  await database.collection('categorias').insertMany(cats)
  const byName = Object.fromEntries(cats.map((c) => [c.nome, c.id]))

  const prods = [
    ['Bruschetta Artesanal', 'Entradas', 24.9],
    ['Carpaccio', 'Entradas', 32.0],
    ['Filet ao Molho Madeira', 'Pratos Principais', 68.9],
    ['Risoto de Camarao', 'Pratos Principais', 72.5],
    ['Massa ao Pesto', 'Pratos Principais', 48.0],
    ['Burger Signature', 'Pratos Principais', 42.9],
    ['Suco Natural', 'Bebidas', 12.0],
    ['Vinho Taca', 'Bebidas', 28.0],
    ['Agua com Gas', 'Bebidas', 7.5],
    ['Petit Gateau', 'Sobremesas', 26.9],
    ['Cheesecake', 'Sobremesas', 24.0],
  ].map(([nome, cat, preco]) => ({
    id: uuidv4(),
    empresa_id,
    categoria_id: byName[cat],
    nome,
    descricao: '',
    preco,
    imagem: null,
    disponivel: true,
    ativo: true,
    created_at: new Date(),
  }))
  await database.collection('produtos').insertMany(prods)

  const clientes = [
    ['Ana Souza', '5511988880001'],
    ['Bruno Lima', '5511988880002'],
    ['Carla Mendes', '5511988880003'],
  ].map(([nome, telefone]) => ({
    id: uuidv4(),
    empresa_id,
    nome,
    telefone,
    email: `${slugify(nome)}@exemplo.com`,
    endereco: 'Rua Exemplo, 100',
    observacoes: '',
    total_pedidos: 0,
    total_gasto: 0,
    created_at: new Date(),
  }))
  await database.collection('clientes').insertMany(clientes)

  // Pedidos distribuidos nos ultimos 7 dias -> popula dashboard e financeiro
  const statuses = ['concluido', 'concluido', 'concluido', 'pronto', 'em_preparo', 'recebido', 'cancelado']
  const pedidos = []
  const transacoes = []
  let numero = 0
  for (let d = 6; d >= 0; d--) {
    const qtd = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < qtd; i++) {
      numero++
      const cliente = clientes[Math.floor(Math.random() * clientes.length)]
      const nItems = 1 + Math.floor(Math.random() * 3)
      const itens = []
      let total = 0
      for (let k = 0; k < nItems; k++) {
        const p = prods[Math.floor(Math.random() * prods.length)]
        const q = 1 + Math.floor(Math.random() * 2)
        itens.push({ produto_id: p.id, nome: p.nome, preco: p.preco, quantidade: q })
        total += p.preco * q
      }
      const status = statuses[Math.floor(Math.random() * statuses.length)]
      const created = new Date(now - d * 86400000 - Math.floor(Math.random() * 8) * 3600000)
      const pedido = {
        id: uuidv4(),
        empresa_id,
        numero,
        cliente_id: cliente.id,
        cliente_nome: cliente.nome,
        itens,
        tipo: ['balcao', 'delivery', 'retirada'][Math.floor(Math.random() * 3)],
        pagamento: ['pix', 'cartao', 'dinheiro'][Math.floor(Math.random() * 3)],
        status,
        observacoes: '',
        total: Math.round(total * 100) / 100,
        created_at: created,
        updated_at: created,
      }
      pedidos.push(pedido)
      if (status === 'concluido') {
        transacoes.push({
          id: uuidv4(),
          empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Pedido #${numero}`,
          valor: pedido.total,
          pedido_id: pedido.id,
          data: created,
          created_at: created,
        })
      }
    }
  }
  // algumas despesas
  for (let d = 6; d >= 0; d -= 2) {
    transacoes.push({
      id: uuidv4(),
      empresa_id,
      tipo: 'despesa',
      categoria: ['Insumos', 'Fornecedores', 'Operacional'][Math.floor(Math.random() * 3)],
      descricao: 'Despesa operacional',
      valor: Math.round((80 + Math.random() * 200) * 100) / 100,
      pedido_id: null,
      data: new Date(now - d * 86400000),
      created_at: new Date(now - d * 86400000),
    })
  }
  if (pedidos.length) await database.collection('pedidos').insertMany(pedidos)
  if (transacoes.length) await database.collection('transacoes').insertMany(transacoes)

  // Registro de integracoes vazias (prontas para ativar)
  await database.collection('integracoes').insertMany([
    { id: uuidv4(), empresa_id, tipo: 'evolution', config: {}, status: 'nao_configurado', created_at: new Date() },
    { id: uuidv4(), empresa_id, tipo: 'n8n', config: {}, status: 'nao_configurado', created_at: new Date() },
    { id: uuidv4(), empresa_id, tipo: 'mercadopago', config: { mode: 'sandbox' }, status: 'nao_configurado', created_at: new Date() },
  ])

  // Salao: 8 mesas. Abre uma comanda demo na Mesa 02 para visualizacao imediata.
  const mesas = []
  for (let n = 1; n <= 8; n++) {
    mesas.push({ id: uuidv4(), empresa_id, numero: n, nome: `Mesa ${padMesa(n)}`, capacidade: 4, status: 'livre', comanda_id: null, ativo: true, created_at: new Date(), updated_at: new Date() })
  }
  const mesaDemo = mesas[1]
  const comandaId = uuidv4()
  const itensDemo = [
    { produto_id: prods[5].id, nome: prods[5].nome, preco: prods[5].preco, quantidade: 2, observacao: 'Sem cebola', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
    { produto_id: prods[6].id, nome: prods[6].nome, preco: prods[6].preco, quantidade: 2, observacao: '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
    { produto_id: prods[8].id, nome: prods[8].nome, preco: prods[8].preco, quantidade: 1, observacao: '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
  ]
  const comandaBase = {
    id: comandaId, empresa_id, mesa_id: mesaDemo.id, mesa_nome: mesaDemo.nome,
    cliente_id: clientes[0].id, cliente_nome: clientes[0].nome, pessoas: 3, status: 'aberta',
    itens: itensDemo, desconto: 0, desconto_tipo: 'valor', taxa_servico_percent: 10,
    pagamentos: [], operador_id: ctx.usuario_id, operador_nome: ctx.nome,
    aberta_em: new Date(), fechada_em: null, created_at: new Date(), updated_at: new Date(),
  }
  Object.assign(comandaBase, computeComanda(comandaBase))
  mesaDemo.status = 'ocupada'
  mesaDemo.comanda_id = comandaId
  await database.collection('mesas').insertMany(mesas)
  await database.collection('comandas').insertOne(comandaBase)

  await audit(database, ctx, 'seed', 'empresa', empresa_id, { produtos: prods.length, pedidos: pedidos.length, mesas: mesas.length })
}

/* ======================================================================= */
/* ============================ CONTROLLERS ============================== */
/* ======================================================================= */

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }))
}

async function handler(request, { params }) {
  const { path = [] } = await params
  const seg = Array.isArray(path) ? path : []
  const route = `/${seg.join('/')}`
  const method = request.method

  try {
    const database = await getDb()

    /* -------- health / meta -------- */
    if (route === '/' || route === '/health') {
      return json({ service: 'restaurant-os', status: 'ok', providers: { supabase: supabaseProviderStatus() } })
    }

    /* ==================== AUTH ==================== */
    if (route === '/auth/register' && method === 'POST') {
      const body = await request.json()
      const { empresa_nome, nome, email, senha } = body || {}
      if (!empresa_nome || !nome || !email || !senha) return err('Campos obrigatorios: empresa_nome, nome, email, senha')
      const emailNorm = String(email).toLowerCase().trim()
      const exists = await database.collection('usuarios').findOne({ email: emailNorm })
      if (exists) return err('E-mail ja cadastrado', 409)

      const empresa_id = uuidv4()
      let slug = slugify(empresa_nome)
      if (await database.collection('empresas').findOne({ slug })) slug = `${slug}-${empresa_id.slice(0, 6)}`
      const empresa = {
        id: empresa_id,
        nome: empresa_nome,
        slug,
        plano: 'free',
        telefone: '',
        endereco: '',
        moeda: 'BRL',
        nome_comercial: empresa_nome,
        cnpj: '',
        whatsapp: '',
        email: emailNorm,
        logo: null,
        horario_funcionamento: '',
        config: {
          feature_flags: { mesas: true, comandas: true, estoque: false, crm: false, campanhas: false, fidelidade: false, cashback: false, billing: false, caixa: false, multiunidade: false },
          appearance: { cor_principal: '#4f46e5', cor_secundaria: '#7c3aed', tema: 'dark', nome_exibido: empresa_nome },
          pagamentos: { metodos: { dinheiro: true, pix: true, cartao_debito: true, cartao_credito: true }, taxa_servico_padrao: 10 },
        },
        ativo: true,
        created_at: new Date(),
      }
      await database.collection('empresas').insertOne(empresa)

      const usuario_id = uuidv4()
      const usuario = {
        id: usuario_id,
        empresa_id,
        nome,
        email: emailNorm,
        senha_hash: hashPassword(senha),
        papel: 'OWNER',
        ativo: true,
        created_at: new Date(),
      }
      await database.collection('usuarios').insertOne(usuario)

      const ctx = { empresa_id, usuario_id, nome, papel: 'OWNER' }
      await seedEmpresa(database, empresa_id, ctx)
      await audit(database, ctx, 'register', 'empresa', empresa_id, { empresa_nome })

      const token = signToken({ usuario_id, empresa_id, papel: 'OWNER' })
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS.OWNER })
    }

    if (route === '/auth/login' && method === 'POST') {
      const { email, senha } = (await request.json()) || {}
      if (!email || !senha) return err('E-mail e senha obrigatorios')
      const usuario = await database.collection('usuarios').findOne({ email: String(email).toLowerCase().trim() })
      if (!usuario || !verifyPassword(senha, usuario.senha_hash)) return err('Credenciais invalidas', 401)
      if (!usuario.ativo) return err('Usuario inativo', 403)
      const empresa = await database.collection('empresas').findOne({ id: usuario.empresa_id })
      const token = signToken({ usuario_id: usuario.id, empresa_id: usuario.empresa_id, papel: usuario.papel })
      await audit(database, { empresa_id: usuario.empresa_id, usuario_id: usuario.id, nome: usuario.nome }, 'login', 'usuario', usuario.id)
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS[usuario.papel] || [] })
    }

    /* ==================== WEBHOOK MERCADO PAGO (pre-auth, assinado) ==================== */
    if (route === '/pagamentos/webhook/mercadopago' && method === 'POST') {
      const url = new URL(request.url)
      const empresaId = url.searchParams.get('tenant')
      const dataId = url.searchParams.get('data.id') || url.searchParams.get('id')
      if (!empresaId || !dataId) return json({ error: 'params ausentes' }, 400)
      const integ = await database.collection('integracoes').findOne({ empresa_id: empresaId, tipo: 'mercadopago' })
      if (!integ || !isGatewayConfigured('mercadopago', integ.config)) return json({ error: 'nao configurado' }, 404)
      let provider
      try { provider = getPaymentProvider('mercadopago', integ.config) } catch { return json({ error: 'provider' }, 404) }
      const ok = provider.verifyWebhook({
        signature: request.headers.get('x-signature') || undefined,
        requestId: request.headers.get('x-request-id') || undefined,
        dataId,
      })
      if (!ok) return json({ error: 'assinatura invalida' }, 401)
      // idempotencia: dedupe por evento
      const eventKey = `${empresaId}:${dataId}:${request.headers.get('x-request-id') || ''}`
      const dedupe = await database.collection('webhook_events').updateOne(
        { eventKey }, { $setOnInsert: { eventKey, empresa_id: empresaId, provider: 'mercadopago', received_at: new Date() } }, { upsert: true }
      )
      if (!dedupe.upsertedCount) return json({ ok: true, duplicated: true })
      // busca status autoritativo no gateway
      let statusInfo
      try { statusInfo = await provider.getStatus(dataId) } catch { return json({ ok: true }) }
      await database.collection('pagamentos').updateOne(
        { empresa_id: empresaId, provider: 'mercadopago', provider_payment_id: String(dataId) },
        { $set: { status: statusInfo.status, updated_at: new Date() } }
      )
      return json({ ok: true, status: statusInfo.status })
    }

    /* ---- a partir daqui, tudo autenticado ---- */
    const session = await auth(request)
    if (!session) return err('Nao autorizado', 401)
    const usuario = await database.collection('usuarios').findOne({ id: session.usuario_id, empresa_id: session.empresa_id })
    if (!usuario || !usuario.ativo) return err('Sessao invalida', 401)
    const ctx = { empresa_id: session.empresa_id, usuario_id: session.usuario_id, nome: usuario.nome, papel: usuario.papel }
    const tenant = { empresa_id: ctx.empresa_id } // escopo multitenant obrigatorio

    if (route === '/auth/me' && method === 'GET') {
      const empresa = await database.collection('empresas').findOne({ id: ctx.empresa_id })
      return json({ usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS[usuario.papel] || [], roles: ROLES })
    }

    /* ==================== EMPRESA ==================== */
    if (route === '/empresa' && method === 'GET') {
      return json(clean(await database.collection('empresas').findOne({ id: ctx.empresa_id })))
    }
    if (route === '/empresa' && method === 'PUT') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const current = await database.collection('empresas').findOne({ id: ctx.empresa_id })
      const upd = {}
      for (const k of ['nome', 'telefone', 'endereco', 'moeda', 'nome_comercial', 'cnpj', 'whatsapp', 'email', 'logo', 'horario_funcionamento']) {
        if (b[k] !== undefined) upd[k] = b[k]
      }
      // merge profundo de config (appearance / pagamentos / feature_flags)
      const config = { ...(current?.config || {}) }
      if (b.config) {
        if (b.config.appearance) config.appearance = { ...(config.appearance || {}), ...b.config.appearance }
        if (b.config.pagamentos) config.pagamentos = { ...(config.pagamentos || {}), ...b.config.pagamentos }
        if (b.config.feature_flags) config.feature_flags = { ...(config.feature_flags || {}), ...b.config.feature_flags }
      }
      upd.config = config
      upd.updated_at = new Date()
      await database.collection('empresas').updateOne({ id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'empresa', ctx.empresa_id, { campos: Object.keys(upd) })
      return json(clean(await database.collection('empresas').findOne({ id: ctx.empresa_id })))
    }

    /* ==================== USUARIOS ==================== */
    if (route === '/usuarios' && method === 'GET') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const list = await database.collection('usuarios').find(tenant).sort({ created_at: -1 }).toArray()
      return json(list.map(clean))
    }
    if (route === '/usuarios' && method === 'POST') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome || !b.email || !b.senha) return err('nome, email e senha obrigatorios')
      const emailNorm = String(b.email).toLowerCase().trim()
      if (await database.collection('usuarios').findOne({ email: emailNorm })) return err('E-mail ja cadastrado', 409)
      const novo = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        nome: b.nome,
        email: emailNorm,
        senha_hash: hashPassword(b.senha),
        papel: ROLES[b.papel] ? b.papel : 'ATENDENTE',
        ativo: true,
        created_at: new Date(),
      }
      await database.collection('usuarios').insertOne(novo)
      await audit(database, ctx, 'create', 'usuario', novo.id, { email: emailNorm, papel: novo.papel })
      return json(clean(novo), 201)
    }
    if (seg[0] === 'usuarios' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'papel', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.senha) upd.senha_hash = hashPassword(b.senha)
      await database.collection('usuarios').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'usuario', seg[1], upd)
      return json(clean(await database.collection('usuarios').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }
    if (seg[0] === 'usuarios' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      if (seg[1] === ctx.usuario_id) return err('Voce nao pode remover a si mesmo', 400)
      await database.collection('usuarios').deleteOne({ id: seg[1], empresa_id: ctx.empresa_id })
      await audit(database, ctx, 'delete', 'usuario', seg[1])
      return json({ ok: true })
    }

    /* ==================== CATEGORIAS ==================== */
    if (route === '/categorias' && method === 'GET') {
      const list = await database.collection('categorias').find(tenant).sort({ ordem: 1 }).toArray()
      return json(list.map(clean))
    }
    if (route === '/categorias' && method === 'POST') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome) return err('nome obrigatorio')
      const doc = { id: uuidv4(), empresa_id: ctx.empresa_id, nome: b.nome, ordem: b.ordem ?? 99, ativo: true, created_at: new Date() }
      await database.collection('categorias').insertOne(doc)
      await audit(database, ctx, 'create', 'categoria', doc.id, { nome: b.nome })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'categorias' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'ordem', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      await database.collection('categorias').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'categoria', seg[1], upd)
      return json(clean(await database.collection('categorias').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }
    if (seg[0] === 'categorias' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      await database.collection('categorias').deleteOne({ id: seg[1], empresa_id: ctx.empresa_id })
      await database.collection('produtos').deleteMany({ categoria_id: seg[1], empresa_id: ctx.empresa_id })
      await audit(database, ctx, 'delete', 'categoria', seg[1])
      return json({ ok: true })
    }

    /* ==================== PRODUTOS ==================== */
    if (route === '/produtos' && method === 'GET') {
      const list = await database.collection('produtos').find(tenant).sort({ created_at: -1 }).toArray()
      return json(list.map(clean))
    }
    if (route === '/produtos' && method === 'POST') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome || b.preco === undefined) return err('nome e preco obrigatorios')
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        categoria_id: b.categoria_id || null,
        nome: b.nome,
        descricao: b.descricao || '',
        preco: Number(b.preco),
        imagem: b.imagem || null,
        disponivel: b.disponivel !== false,
        ativo: true,
        created_at: new Date(),
      }
      await database.collection('produtos').insertOne(doc)
      await audit(database, ctx, 'create', 'produto', doc.id, { nome: b.nome, preco: doc.preco })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'produtos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['categoria_id', 'nome', 'descricao', 'imagem', 'disponivel', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.preco !== undefined) upd.preco = Number(b.preco)
      await database.collection('produtos').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'produto', seg[1], upd)
      return json(clean(await database.collection('produtos').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }
    if (seg[0] === 'produtos' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      await database.collection('produtos').deleteOne({ id: seg[1], empresa_id: ctx.empresa_id })
      await audit(database, ctx, 'delete', 'produto', seg[1])
      return json({ ok: true })
    }

    /* ==================== CLIENTES ==================== */
    if (route === '/clientes' && method === 'GET') {
      const list = await database.collection('clientes').find(tenant).sort({ created_at: -1 }).toArray()
      return json(list.map(clean))
    }
    if (route === '/clientes' && method === 'POST') {
      if (!can(ctx.papel, 'clientes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome) return err('nome obrigatorio')
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        nome: b.nome,
        telefone: b.telefone || '',
        email: b.email || '',
        endereco: b.endereco || '',
        observacoes: b.observacoes || '',
        total_pedidos: 0,
        total_gasto: 0,
        created_at: new Date(),
      }
      await database.collection('clientes').insertOne(doc)
      await audit(database, ctx, 'create', 'cliente', doc.id, { nome: b.nome })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'clientes' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'clientes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'telefone', 'email', 'endereco', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      await database.collection('clientes').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'cliente', seg[1], upd)
      return json(clean(await database.collection('clientes').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }
    if (seg[0] === 'clientes' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'clientes')) return err('Sem permissao', 403)
      await database.collection('clientes').deleteOne({ id: seg[1], empresa_id: ctx.empresa_id })
      await audit(database, ctx, 'delete', 'cliente', seg[1])
      return json({ ok: true })
    }

    /* ==================== PEDIDOS ==================== */
    if (route === '/pedidos' && method === 'GET') {
      const url = new URL(request.url)
      const status = url.searchParams.get('status')
      const q = { ...tenant, ...(status ? { status } : {}) }
      const list = await database.collection('pedidos').find(q).sort({ created_at: -1 }).limit(500).toArray()
      return json(list.map(clean))
    }
    if (route === '/pedidos' && method === 'POST') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const itens = Array.isArray(b.itens) ? b.itens : []
      if (!itens.length) return err('Pedido precisa de ao menos 1 item')
      const total = Math.round(itens.reduce((s, it) => s + Number(it.preco) * Number(it.quantidade || 1), 0) * 100) / 100
      const numero = (await database.collection('pedidos').countDocuments(tenant)) + 1
      let cliente_nome = b.cliente_nome || 'Consumidor'
      if (b.cliente_id) {
        const c = await database.collection('clientes').findOne({ id: b.cliente_id, empresa_id: ctx.empresa_id })
        if (c) cliente_nome = c.nome
      }
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        numero,
        cliente_id: b.cliente_id || null,
        cliente_nome,
        itens,
        tipo: b.tipo || 'balcao',
        pagamento: b.pagamento || 'pix',
        status: b.status || 'recebido',
        observacoes: b.observacoes || '',
        total,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await database.collection('pedidos').insertOne(doc)
      await audit(database, ctx, 'create', 'pedido', doc.id, { numero, total })
      await emitEvent(database, ctx, 'order.created', { pedido: clean(doc) })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'pedidos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const pedido = await database.collection('pedidos').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!pedido) return err('Pedido nao encontrado', 404)
      const upd = { updated_at: new Date() }
      for (const k of ['status', 'tipo', 'pagamento', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      await database.collection('pedidos').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })

      // Regra de negocio: ao concluir, gera receita e atualiza metricas do cliente
      if (b.status === 'concluido' && pedido.status !== 'concluido') {
        await database.collection('transacoes').insertOne({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Pedido #${pedido.numero}`,
          valor: pedido.total,
          pedido_id: pedido.id,
          data: new Date(),
          created_at: new Date(),
        })
        if (pedido.cliente_id) {
          await database.collection('clientes').updateOne(
            { id: pedido.cliente_id, empresa_id: ctx.empresa_id },
            { $inc: { total_pedidos: 1, total_gasto: pedido.total } }
          )
        }
      }
      await audit(database, ctx, 'update', 'pedido', seg[1], upd)
      if (b.status) await emitEvent(database, ctx, 'order.status_changed', { pedido_id: seg[1], numero: pedido.numero, status: b.status })
      return json(clean(await database.collection('pedidos').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }

    /* ==================== FINANCEIRO ==================== */
    if (route === '/financeiro/transacoes' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const list = await database.collection('transacoes').find(tenant).sort({ data: -1 }).limit(500).toArray()
      return json(list.map(clean))
    }
    if (route === '/financeiro/transacoes' && method === 'POST') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.tipo || b.valor === undefined) return err('tipo e valor obrigatorios')
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        tipo: b.tipo,
        categoria: b.categoria || 'Outros',
        descricao: b.descricao || '',
        valor: Number(b.valor),
        pedido_id: null,
        data: b.data ? new Date(b.data) : new Date(),
        created_at: new Date(),
      }
      await database.collection('transacoes').insertOne(doc)
      await audit(database, ctx, 'create', 'transacao', doc.id, { tipo: doc.tipo, valor: doc.valor })
      return json(clean(doc), 201)
    }
    if (route === '/financeiro/resumo' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const list = await database.collection('transacoes').find(tenant).toArray()
      const receitas = list.filter((t) => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0)
      const despesas = list.filter((t) => t.tipo === 'despesa').reduce((s, t) => s + t.valor, 0)
      const days = []
      for (let d = 6; d >= 0; d--) {
        const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d)
        const next = new Date(day); next.setDate(next.getDate() + 1)
        const dayTx = list.filter((t) => new Date(t.data) >= day && new Date(t.data) < next)
        days.push({
          dia: day.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          receita: Math.round(dayTx.filter((t) => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0) * 100) / 100,
          despesa: Math.round(dayTx.filter((t) => t.tipo === 'despesa').reduce((s, t) => s + t.valor, 0) * 100) / 100,
        })
      }
      return json({ receitas: Math.round(receitas * 100) / 100, despesas: Math.round(despesas * 100) / 100, saldo: Math.round((receitas - despesas) * 100) / 100, serie: days })
    }

    /* ==================== DASHBOARD ==================== */
    if (route === '/dashboard/metrics' && method === 'GET') {
      const [pedidos, transacoes, produtos, clientes] = await Promise.all([
        database.collection('pedidos').find(tenant).toArray(),
        database.collection('transacoes').find(tenant).toArray(),
        database.collection('produtos').find(tenant).toArray(),
        database.collection('clientes').countDocuments(tenant),
      ])
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const pedidosHoje = pedidos.filter((p) => new Date(p.created_at) >= today)
      const receitaHoje = transacoes.filter((t) => t.tipo === 'receita' && new Date(t.data) >= today).reduce((s, t) => s + t.valor, 0)
      const concluidos = pedidos.filter((p) => p.status === 'concluido')
      const ticketMedio = concluidos.length ? concluidos.reduce((s, p) => s + p.total, 0) / concluidos.length : 0

      const serie = []
      for (let d = 6; d >= 0; d--) {
        const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - d)
        const next = new Date(day); next.setDate(next.getDate() + 1)
        serie.push({
          dia: day.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''),
          faturamento: Math.round(transacoes.filter((t) => t.tipo === 'receita' && new Date(t.data) >= day && new Date(t.data) < next).reduce((s, t) => s + t.valor, 0) * 100) / 100,
          pedidos: pedidos.filter((p) => new Date(p.created_at) >= day && new Date(p.created_at) < next).length,
        })
      }
      const counter = {}
      for (const p of pedidos) for (const it of p.itens || []) counter[it.nome] = (counter[it.nome] || 0) + Number(it.quantidade || 1)
      const topProdutos = Object.entries(counter).map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd).slice(0, 5)
      const recentes = [...pedidos].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 6).map(clean)
      const porStatus = ['recebido', 'em_preparo', 'pronto', 'concluido', 'cancelado'].map((s) => ({ status: s, total: pedidos.filter((p) => p.status === s).length }))

      return json({
        faturamentoHoje: Math.round(receitaHoje * 100) / 100,
        pedidosHoje: pedidosHoje.length,
        ticketMedio: Math.round(ticketMedio * 100) / 100,
        totalClientes: clientes,
        totalProdutos: produtos.length,
        serie, topProdutos, recentes, porStatus,
      })
    }

    /* ==================== AUDITORIA ==================== */
    if (route === '/auditoria' && method === 'GET') {
      if (!can(ctx.papel, 'auditoria')) return err('Sem permissao', 403)
      const list = await database.collection('auditoria').find(tenant).sort({ created_at: -1 }).limit(200).toArray()
      return json(list.map(clean))
    }

    /* ==================== INTEGRACOES ==================== */
    if (route === '/integracoes' && method === 'GET') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const list = await database.collection('integracoes').find(tenant).toArray()
      const map = {}
      for (const i of list) {
        const c = clean(i)
        // Nunca expor credenciais sensiveis (access token) ao client.
        if (c.tipo === 'mercadopago' && c.config) {
          c.config = { mode: c.config.mode || 'sandbox', hasAccessToken: Boolean(c.config.accessToken), hasWebhookSecret: Boolean(c.config.webhookSecret) }
        }
        map[i.tipo] = c
      }
      return json({ evolution: map.evolution || null, n8n: map.n8n || null, mercadopago: map.mercadopago || null, gateways: PAYMENT_GATEWAYS, methods: PAYMENT_METHODS })
    }
    if (route === '/integracoes/mercadopago' && method === 'PUT') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const current = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'mercadopago' })
      const config = {
        mode: b.mode || current?.config?.mode || 'sandbox',
        // mantem token existente se vier vazio (permite editar outros campos sem reenviar)
        accessToken: b.accessToken !== undefined && b.accessToken !== '' ? b.accessToken : current?.config?.accessToken || '',
        webhookSecret: b.webhookSecret !== undefined && b.webhookSecret !== '' ? b.webhookSecret : current?.config?.webhookSecret || '',
      }
      const status = config.accessToken ? 'configurado' : 'nao_configurado'
      await database.collection('integracoes').updateOne(
        { empresa_id: ctx.empresa_id, tipo: 'mercadopago' },
        { $set: { config, status, updated_at: new Date() }, $setOnInsert: { id: uuidv4(), empresa_id: ctx.empresa_id, tipo: 'mercadopago', created_at: new Date() } },
        { upsert: true }
      )
      await audit(database, ctx, 'update', 'integracao', 'mercadopago', { status, mode: config.mode })
      return json({ ok: true, status, mode: config.mode, hasAccessToken: Boolean(config.accessToken) })
    }
    if (route === '/integracoes/evolution' && method === 'PUT') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const config = { serverUrl: b.serverUrl || '', apiKey: b.apiKey || '', instance: b.instance || 'restaurant-os' }
      const status = config.serverUrl && config.apiKey ? 'configurado' : 'nao_configurado'
      await database.collection('integracoes').updateOne(
        { empresa_id: ctx.empresa_id, tipo: 'evolution' },
        { $set: { config, status, updated_at: new Date() }, $setOnInsert: { id: uuidv4(), empresa_id: ctx.empresa_id, tipo: 'evolution', created_at: new Date() } },
        { upsert: true }
      )
      await audit(database, ctx, 'update', 'integracao', 'evolution', { status })
      return json(clean(await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'evolution' })))
    }
    if (route === '/integracoes/n8n' && method === 'PUT') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const config = { webhookUrl: b.webhookUrl || '', apiKey: b.apiKey || '', eventos: b.eventos || ['order.created', 'order.status_changed'] }
      const status = config.webhookUrl ? 'configurado' : 'nao_configurado'
      await database.collection('integracoes').updateOne(
        { empresa_id: ctx.empresa_id, tipo: 'n8n' },
        { $set: { config, status, updated_at: new Date() }, $setOnInsert: { id: uuidv4(), empresa_id: ctx.empresa_id, tipo: 'n8n', created_at: new Date() } },
        { upsert: true }
      )
      await audit(database, ctx, 'update', 'integracao', 'n8n', { status })
      return json(clean(await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'n8n' })))
    }
    if (route === '/integracoes/evolution/testar' && method === 'POST') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const integ = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'evolution' })
      const result = await fetchInstanceStatus(integ?.config || {})
      return json(result)
    }
    if (route === '/integracoes/n8n/testar' && method === 'POST') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const integ = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'n8n' })
      const result = await testN8nConnection(integ?.config || {})
      return json(result)
    }

    /* ==================== MESAS (salao) ==================== */
    if (route === '/mesas' && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const mesas = await database.collection('mesas').find({ ...tenant, ativo: true }).sort({ numero: 1 }).toArray()
      // anexa resumo da comanda aberta
      const comandaIds = mesas.map((m) => m.comanda_id).filter(Boolean)
      const comandas = comandaIds.length ? await database.collection('comandas').find({ empresa_id: ctx.empresa_id, id: { $in: comandaIds } }).toArray() : []
      const byId = Object.fromEntries(comandas.map((c) => [c.id, c]))
      const out = mesas.map((m) => {
        const c = m.comanda_id ? byId[m.comanda_id] : null
        return { ...clean(m), comanda: c ? { id: c.id, total: c.total, pessoas: c.pessoas, cliente_nome: c.cliente_nome, itens_count: (c.itens || []).length, aberta_em: c.aberta_em } : null }
      })
      return json(out)
    }
    if (route === '/mesas/configurar' && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const quantidade = Math.max(0, Math.min(500, Number(b.quantidade || 0)))
      const capacidade = Number(b.capacidade || 4)
      const existentes = await database.collection('mesas').find(tenant).sort({ numero: 1 }).toArray()
      const maxNum = existentes.reduce((mx, m) => Math.max(mx, m.numero), 0)
      const novas = []
      for (let n = existentes.length + 1; n <= quantidade; n++) {
        const numero = Math.max(n, maxNum + 1) // garante numeracao unica crescente
        novas.push({ id: uuidv4(), empresa_id: ctx.empresa_id, numero: n, nome: `Mesa ${padMesa(n)}`, capacidade, status: 'livre', comanda_id: null, ativo: true, created_at: new Date(), updated_at: new Date() })
      }
      if (novas.length) await database.collection('mesas').insertMany(novas)
      // se reduzir: desativa mesas livres excedentes (nunca remove com comanda aberta)
      if (quantidade < existentes.length) {
        const excedentes = existentes.filter((m) => m.numero > quantidade && m.status === 'livre')
        for (const m of excedentes) await database.collection('mesas').updateOne({ id: m.id, empresa_id: ctx.empresa_id }, { $set: { ativo: false, updated_at: new Date() } })
      }
      await audit(database, ctx, 'configurar', 'mesas', ctx.empresa_id, { quantidade, capacidade })
      const mesas = await database.collection('mesas').find({ ...tenant, ativo: true }).sort({ numero: 1 }).toArray()
      return json(mesas.map(clean))
    }
    if (seg[0] === 'mesas' && seg[1] && seg[2] === 'abrir' && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const mesa = await database.collection('mesas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!mesa) return err('Mesa nao encontrada', 404)
      if (mesa.comanda_id) return err('Mesa ja possui comanda aberta', 409)
      const b = (await request.json()) || {}
      let cliente_nome = b.cliente_nome || 'Cliente'
      if (b.cliente_id) {
        const c = await database.collection('clientes').findOne({ id: b.cliente_id, empresa_id: ctx.empresa_id })
        if (c) cliente_nome = c.nome
      }
      const emp = await database.collection('empresas').findOne({ id: ctx.empresa_id })
      const comanda = {
        id: uuidv4(), empresa_id: ctx.empresa_id, mesa_id: mesa.id, mesa_nome: mesa.nome,
        cliente_id: b.cliente_id || null, cliente_nome, pessoas: Number(b.pessoas || 1), status: 'aberta',
        itens: [], desconto: 0, desconto_tipo: 'valor', taxa_servico_percent: Number(emp?.config?.pagamentos?.taxa_servico_padrao ?? 10),
        pagamentos: [], operador_id: ctx.usuario_id, operador_nome: ctx.nome,
        aberta_em: new Date(), fechada_em: null, created_at: new Date(), updated_at: new Date(),
      }
      Object.assign(comanda, computeComanda(comanda))
      await database.collection('comandas').insertOne(comanda)
      await database.collection('mesas').updateOne({ id: mesa.id, empresa_id: ctx.empresa_id }, { $set: { status: 'ocupada', comanda_id: comanda.id, updated_at: new Date() } })
      await audit(database, ctx, 'abrir', 'comanda', comanda.id, { mesa: mesa.nome })
      return json(clean(comanda), 201)
    }
    if (seg[0] === 'mesas' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = { updated_at: new Date() }
      for (const k of ['nome', 'capacidade']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.status !== undefined && MESA_STATUS.includes(b.status)) upd.status = b.status
      await database.collection('mesas').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'mesa', seg[1], upd)
      return json(clean(await database.collection('mesas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })))
    }

    /* ==================== COMANDAS ==================== */
    const reloadComanda = async (id) => {
      const c = await database.collection('comandas').findOne({ id, empresa_id: ctx.empresa_id })
      if (!c) return null
      Object.assign(c, computeComanda(c))
      await database.collection('comandas').updateOne({ id, empresa_id: ctx.empresa_id }, { $set: { subtotal: c.subtotal, desconto_valor: c.desconto_valor, taxa_valor: c.taxa_valor, total: c.total, pago: c.pago, restante: c.restante, updated_at: new Date() } })
      if (c.mesa_id) {
        const mesaStatus = c.restante <= 0 && c.total > 0 ? 'aguardando_pagamento' : 'ocupada'
        await database.collection('mesas').updateOne({ id: c.mesa_id, empresa_id: ctx.empresa_id, status: { $ne: 'livre' } }, { $set: { status: mesaStatus } })
      }
      return c
    }
    if (route === '/comandas' && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const url = new URL(request.url)
      const status = url.searchParams.get('status')
      const q = { ...tenant, ...(status ? { status } : {}) }
      const list = await database.collection('comandas').find(q).sort({ created_at: -1 }).limit(500).toArray()
      return json(list.map(clean))
    }
    if (seg[0] === 'comandas' && seg[1] && seg.length === 2 && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const c = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!c) return err('Comanda nao encontrada', 404)
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && !seg[3] && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      let nome = b.nome, preco = b.preco
      if (b.produto_id) {
        const p = await database.collection('produtos').findOne({ id: b.produto_id, empresa_id: ctx.empresa_id })
        if (p) { nome = p.nome; preco = p.preco }
      }
      if (!nome || preco === undefined) return err('produto invalido')
      const item = { id: uuidv4(), produto_id: b.produto_id || null, nome, preco: Number(preco), quantidade: Number(b.quantidade || 1), observacao: b.observacao || '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() }
      await database.collection('comandas').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $push: { itens: item } })
      const c = await reloadComanda(seg[1])
      await audit(database, ctx, 'add_item', 'comanda', seg[1], { item: nome, quantidade: item.quantidade })
      return json(clean(c), 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && seg[3] && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const set = {}
      if (b.quantidade !== undefined) set['itens.$.quantidade'] = Number(b.quantidade)
      if (b.observacao !== undefined) set['itens.$.observacao'] = b.observacao
      await database.collection('comandas').updateOne({ id: seg[1], empresa_id: ctx.empresa_id, 'itens.id': seg[3] }, { $set: set })
      const c = await reloadComanda(seg[1])
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && seg[3] && method === 'DELETE') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      await database.collection('comandas').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $pull: { itens: { id: seg[3] } } })
      const c = await reloadComanda(seg[1])
      await audit(database, ctx, 'remove_item', 'comanda', seg[1], { item_id: seg[3] })
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg.length === 2 && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const set = { updated_at: new Date() }
      for (const k of ['pessoas', 'desconto', 'desconto_tipo', 'taxa_servico_percent', 'cliente_id', 'cliente_nome']) if (b[k] !== undefined) set[k] = b[k]
      await database.collection('comandas').updateOne({ id: seg[1], empresa_id: ctx.empresa_id }, { $set: set })
      const c = await reloadComanda(seg[1])
      await audit(database, ctx, 'update', 'comanda', seg[1], set)
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'transferir' && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const destino = await database.collection('mesas').findOne({ id: b.mesa_id, empresa_id: ctx.empresa_id })
      if (!destino) return err('Mesa destino nao encontrada', 404)
      if (destino.comanda_id) return err('Mesa destino ocupada', 409)
      // libera mesa origem
      if (comanda.mesa_id) await database.collection('mesas').updateOne({ id: comanda.mesa_id, empresa_id: ctx.empresa_id }, { $set: { status: 'livre', comanda_id: null, updated_at: new Date() } })
      await database.collection('mesas').updateOne({ id: destino.id, empresa_id: ctx.empresa_id }, { $set: { status: 'ocupada', comanda_id: comanda.id, updated_at: new Date() } })
      await database.collection('comandas').updateOne({ id: comanda.id, empresa_id: ctx.empresa_id }, { $set: { mesa_id: destino.id, mesa_nome: destino.nome, updated_at: new Date() } })
      await audit(database, ctx, 'transferir', 'comanda', comanda.id, { de: comanda.mesa_nome, para: destino.nome })
      return json(clean(await database.collection('comandas').findOne({ id: comanda.id, empresa_id: ctx.empresa_id })))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'pagamentos' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      if (!b.metodo || b.valor === undefined) return err('metodo e valor obrigatorios')
      // pagamento manual (dinheiro/cartao/pix presencial) -> aprovado
      const pagamento = {
        id: uuidv4(), empresa_id: ctx.empresa_id, comanda_id: comanda.id, pedido_id: null,
        metodo: b.metodo, valor: Number(b.valor), status: 'approved', provider: 'manual',
        provider_payment_id: null, external_reference: comanda.id, idempotency_key: uuidv4(),
        created_at: new Date(), updated_at: new Date(),
      }
      await database.collection('pagamentos').insertOne(pagamento) // fonte de verdade (sem delete fisico)
      await database.collection('comandas').updateOne({ id: comanda.id, empresa_id: ctx.empresa_id }, { $push: { pagamentos: { id: pagamento.id, metodo: pagamento.metodo, valor: pagamento.valor, status: 'approved', provider: 'manual', created_at: pagamento.created_at } } })
      const c = await reloadComanda(comanda.id)
      await audit(database, ctx, 'pagamento', 'comanda', comanda.id, { metodo: b.metodo, valor: pagamento.valor })
      return json(clean(c), 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'pix' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const comanda = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const integ = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'mercadopago' })
      if (!integ || !isGatewayConfigured('mercadopago', integ.config)) return err('Mercado Pago nao configurado', 400)
      const b = (await request.json()) || {}
      const totals = computeComanda(comanda)
      const valor = Number(b.valor || totals.restante || totals.total)
      if (valor <= 0) return err('Nada a pagar')
      const idempotency_key = uuidv4()
      const provider = getPaymentProvider('mercadopago', integ.config)
      const base = process.env.NEXT_PUBLIC_BASE_URL || ''
      let result
      try {
        result = await provider.createPix({
          amount: valor, description: `Comanda ${comanda.mesa_nome}`, payerEmail: b.payerEmail || 'cliente@example.com',
          externalReference: `${ctx.empresa_id}:${comanda.id}`, idempotencyKey: idempotency_key,
          notificationUrl: base ? `${base}/api/pagamentos/webhook/mercadopago?tenant=${ctx.empresa_id}` : undefined,
        })
      } catch (e) { return err(`Falha ao gerar Pix: ${e.message}`, 502) }
      const pagamento = {
        id: uuidv4(), empresa_id: ctx.empresa_id, comanda_id: comanda.id, pedido_id: null,
        metodo: 'pix', valor, status: result.status || 'pending', provider: 'mercadopago',
        provider_payment_id: result.providerPaymentId, qr_code: result.qrCode, qr_code_base64: result.qrCodeBase64,
        ticket_url: result.ticketUrl || null, external_reference: `${ctx.empresa_id}:${comanda.id}`, idempotency_key,
        created_at: new Date(), updated_at: new Date(),
      }
      await database.collection('pagamentos').insertOne(pagamento)
      await audit(database, ctx, 'pix_criado', 'comanda', comanda.id, { valor, provider_payment_id: result.providerPaymentId })
      return json({ id: pagamento.id, status: pagamento.status, valor, qr_code: result.qrCode, qr_code_base64: result.qrCodeBase64, ticket_url: result.ticketUrl }, 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'fechar' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const comanda = await database.collection('comandas').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const totals = computeComanda(comanda)
      const b = (await request.json().catch(() => ({}))) || {}
      if (!b.forcar && totals.restante > 0.009) return err(`Restam ${totals.restante} a pagar`, 400)
      // cria pedido (tipo mesa, concluido) para integrar dashboard/financeiro
      const numero = (await database.collection('pedidos').countDocuments(tenant)) + 1
      const pedido = {
        id: uuidv4(), empresa_id: ctx.empresa_id, numero, cliente_id: comanda.cliente_id, cliente_nome: comanda.cliente_nome,
        itens: (comanda.itens || []).map((i) => ({ produto_id: i.produto_id, nome: i.nome, preco: i.preco, quantidade: i.quantidade })),
        tipo: 'mesa', pagamento: (comanda.pagamentos?.[0]?.metodo) || 'dinheiro', status: 'concluido',
        observacoes: `Comanda ${comanda.mesa_nome}`, comanda_id: comanda.id, total: totals.total,
        created_at: new Date(), updated_at: new Date(),
      }
      await database.collection('pedidos').insertOne(pedido)
      await database.collection('transacoes').insertOne({
        id: uuidv4(), empresa_id: ctx.empresa_id, tipo: 'receita', categoria: 'Vendas',
        descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero})`, valor: totals.total, pedido_id: pedido.id, comanda_id: comanda.id,
        data: new Date(), created_at: new Date(),
      })
      if (comanda.cliente_id) await database.collection('clientes').updateOne({ id: comanda.cliente_id, empresa_id: ctx.empresa_id }, { $inc: { total_pedidos: 1, total_gasto: totals.total } })
      await database.collection('comandas').updateOne({ id: comanda.id, empresa_id: ctx.empresa_id }, { $set: { status: 'fechada', fechada_em: new Date(), total: totals.total, updated_at: new Date() } })
      if (comanda.mesa_id) await database.collection('mesas').updateOne({ id: comanda.mesa_id, empresa_id: ctx.empresa_id }, { $set: { status: 'livre', comanda_id: null, updated_at: new Date() } })
      await audit(database, ctx, 'fechar', 'comanda', comanda.id, { total: totals.total, pedido: numero })
      await emitEvent(database, ctx, 'comanda.closed', { comanda_id: comanda.id, total: totals.total })
      return json({ ok: true, pedido_numero: numero, total: totals.total })
    }

    /* ==================== PAGAMENTOS (status) ==================== */
    if (seg[0] === 'pagamentos' && seg[1] && seg.length === 2 && method === 'GET') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const p = await database.collection('pagamentos').findOne({ id: seg[1], empresa_id: ctx.empresa_id })
      if (!p) return err('Pagamento nao encontrado', 404)
      // se pix mercadopago pendente, consulta status autoritativo
      if (p.provider === 'mercadopago' && p.status === 'pending' && p.provider_payment_id) {
        const integ = await database.collection('integracoes').findOne({ empresa_id: ctx.empresa_id, tipo: 'mercadopago' })
        if (integ && isGatewayConfigured('mercadopago', integ.config)) {
          try {
            const st = await getPaymentProvider('mercadopago', integ.config).getStatus(p.provider_payment_id)
            if (st.status !== p.status) { await database.collection('pagamentos').updateOne({ id: p.id, empresa_id: ctx.empresa_id }, { $set: { status: st.status, updated_at: new Date() } }); p.status = st.status }
          } catch { /* ignora */ }
        }
      }
      const { _id, ...rest } = p
      return json(rest)
    }

    return err(`Rota ${route} nao encontrada`, 404)
  } catch (e) {
    console.error('API Error:', e)
    return err('Erro interno do servidor', 500)
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
export const PATCH = handler
