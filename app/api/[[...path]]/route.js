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
    for (const c of ['categorias', 'produtos', 'clientes', 'pedidos', 'transacoes', 'auditoria', 'integracoes']) {
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
  ADMIN: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'financeiro', 'usuarios', 'empresa', 'auditoria', 'integracoes'],
  GERENTE: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'financeiro'],
  ATENDENTE: ['dashboard', 'clientes', 'pedidos'],
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
  ])

  await audit(database, ctx, 'seed', 'empresa', empresa_id, { produtos: prods.length, pedidos: pedidos.length })
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
        config: { feature_flags: { mesas: false, estoque: false, crm: false, campanhas: false, fidelidade: false, billing: false } },
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
      const upd = {}
      for (const k of ['nome', 'telefone', 'endereco', 'moeda']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.config) upd.config = b.config
      await database.collection('empresas').updateOne({ id: ctx.empresa_id }, { $set: upd })
      await audit(database, ctx, 'update', 'empresa', ctx.empresa_id, upd)
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
      for (const i of list) map[i.tipo] = clean(i)
      return json({ evolution: map.evolution || null, n8n: map.n8n || null })
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
