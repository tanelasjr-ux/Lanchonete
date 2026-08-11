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

import { v4 as uuidv4 } from 'uuid'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { fetchInstanceStatus, sendWhatsappMessage } from '@/lib/integrations/evolution'
import { triggerN8nEvent, testN8nConnection } from '@/lib/integrations/n8n'
import { supabaseProviderStatus } from '@/lib/integrations/supabase'
import { getPaymentProvider, isGatewayConfigured, PAYMENT_METHODS, PAYMENT_GATEWAYS } from '@/lib/integrations/payments/provider'
import { getRepositories, getProviderName } from '@/lib/repositories/factory'

/* ============================ INFRA: persistencia ========================
 * A escolha do backend (MongoDB ou Supabase) vive inteiramente em
 * lib/repositories/factory.js, controlada por DATABASE_PROVIDER. Este
 * arquivo nao conhece mais nenhum driver de banco: fala so com os
 * contratos de packages/domain (Fase 7 da migracao).
 * ======================================================================= */

/* ============================ AUTH HELPERS ============================== */
/**
 * Em producao o segredo e OBRIGATORIO: sem ele, qualquer um consegue assinar
 * um token valido para qualquer empresa/usuario (o fallback de dev que existia
 * aqui era um valor publico, versionado no proprio codigo). Falhar no boot e
 * preferivel a subir um ambiente silenciosamente forjavel.
 */
const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET
  if (s) return s
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET e obrigatorio em producao — nao ha valor padrao seguro.')
  }
  return 'ros_dev_secret_apenas_local'
})()
const TOKEN_TTL_SEC = 7 * 24 * 60 * 60
const nowSec = () => Math.floor(Date.now() / 1000)

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}
function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  // `iat`/`exp` em SEGUNDOS (NumericDate, RFC 7519). Antes eram gravados em
  // milissegundos: internamente coerente, mas qualquer biblioteca JWT padrao
  // — inclusive a do Supabase — leria o valor como segundos e concluiria que
  // o token so expira no ano ~58600, ou seja, nunca. Ver PHASE-8-AUTH-AUDIT.
  const body = b64url(JSON.stringify({ ...payload, iat: nowSec(), exp: nowSec() + TOKEN_TTL_SEC }))
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}
function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.')
    const expectedBuf = Buffer.from(crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url'))
    const sigBuf = Buffer.from(sig || '')
    // Comparacao em tempo constante: `!==` em string vaza, pelo tempo de
    // resposta, quantos caracteres iniciais da assinatura estao corretos.
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (!payload.exp) return null
    // Aceita tokens antigos (exp em ms) durante a transicao: qualquer valor
    // acima de ~ano 2286 em segundos so pode ser um timestamp em ms.
    const expSec = payload.exp > 1e11 ? Math.floor(payload.exp / 1000) : payload.exp
    if (expSec < nowSec()) return null
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
  ADMIN: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'mesas', 'financeiro', 'relatorios', 'atendimento', 'usuarios', 'empresa', 'auditoria', 'integracoes', 'pagamentos'],
  GERENTE: ['dashboard', 'cardapio', 'clientes', 'pedidos', 'mesas', 'financeiro', 'relatorios', 'atendimento', 'pagamentos'],
  ATENDENTE: ['dashboard', 'clientes', 'pedidos', 'mesas', 'atendimento', 'pagamentos'],
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
async function audit(repos, ctx, acao, entidade, entidade_id, dados = {}) {
  try {
    await repos.auditoriaRepo.registrar({
      empresa_id: ctx.empresa_id,
      usuario_id: ctx.usuario_id,
      usuario_nome: ctx.nome || null,
      acao,
      entidade,
      entidade_id: entidade_id || null,
      dados,
    })
  } catch {
    /* auditoria nunca deve quebrar o fluxo principal */
  }
}

/* ============================ EVENTOS (n8n) ============================= */
async function emitEvent(repos, ctx, event, payload) {
  try {
    const integ = await repos.integracaoRepo.findByTipo(ctx.empresa_id, 'n8n')
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
async function seedEmpresa(repos, empresa_id, ctx) {
  const now = Date.now()
  const cats = [
    { nome: 'Entradas', ordem: 1 },
    { nome: 'Pratos Principais', ordem: 2 },
    { nome: 'Bebidas', ordem: 3 },
    { nome: 'Sobremesas', ordem: 4 },
  ].map((c) => ({ id: uuidv4(), empresa_id, ...c, ativo: true, created_at: new Date() }))
  await repos.categoriaRepo.createMany(cats)
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
  await repos.produtoRepo.createMany(prods)

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
  await repos.clienteRepo.createMany(clientes)

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
  if (pedidos.length) await repos.pedidoRepo.createMany(pedidos)
  if (transacoes.length) await repos.transacaoRepo.createMany(transacoes)

  // Registro de integracoes vazias (prontas para ativar)
  await repos.integracaoRepo.createMany([
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
  // Duas passadas por causa da dependencia circular mesas <-> comandas
  // (`mesas.comanda_id` -> comandas, `comandas.mesa_id` -> mesas): a mesa
  // entra sem comanda_id, a comanda e criada, e so entao a referencia e
  // fechada. No Mongo a ordem era indiferente (sem FK); no Postgres inserir
  // a mesa apontando para uma comanda inexistente viola
  // `mesas_comanda_id_fkey`. Mesma estrategia da ferramenta de migracao
  // (docs/plans/PHASE-6-MIGRATION-AUDIT.md secao 2). Estado final identico
  // nos dois backends.
  mesaDemo.comanda_id = null
  await repos.mesaRepo.createMany(mesas)
  await repos.comandaRepo.create(comandaBase)
  await repos.mesaRepo.update(empresa_id, mesaDemo.id, { comanda_id: comandaId })
  mesaDemo.comanda_id = comandaId

  // Central de Atendimento: 2 conversas demo
  const conv1 = { id: uuidv4(), empresa_id, cliente_id: clientes[0].id, contato_nome: clientes[0].nome, contato_numero: clientes[0].telefone, status: 'AGUARDANDO_EQUIPE', ultima_mensagem: 'Ola! Meu pedido ja saiu?', ultima_mensagem_em: new Date(now - 5 * 60000), nao_lidas: 2, operador_id: null, pedido_ativo_id: null, created_at: new Date(now - 3600000), updated_at: new Date() }
  const conv2 = { id: uuidv4(), empresa_id, cliente_id: clientes[1].id, contato_nome: clientes[1].nome, contato_numero: clientes[1].telefone, status: 'AGUARDANDO_CLIENTE', ultima_mensagem: 'Perfeito, obrigado!', ultima_mensagem_em: new Date(now - 30 * 60000), nao_lidas: 0, operador_id: ctx.usuario_id, pedido_ativo_id: null, created_at: new Date(now - 7200000), updated_at: new Date() }
  await repos.conversaRepo.createMany([conv1, conv2])
  await repos.mensagemRepo.createMany([
    { id: uuidv4(), empresa_id, conversa_id: conv1.id, direcao: 'in', tipo: 'text', texto: 'Boa noite!', from_me: false, status: 'delivered', created_at: new Date(now - 20 * 60000) },
    { id: uuidv4(), empresa_id, conversa_id: conv1.id, direcao: 'in', tipo: 'text', texto: 'Ola! Meu pedido ja saiu?', from_me: false, status: 'delivered', created_at: new Date(now - 5 * 60000) },
    { id: uuidv4(), empresa_id, conversa_id: conv2.id, direcao: 'in', tipo: 'text', texto: 'Quero fazer um pedido de delivery', from_me: false, status: 'delivered', created_at: new Date(now - 40 * 60000) },
    { id: uuidv4(), empresa_id, conversa_id: conv2.id, direcao: 'out', tipo: 'text', texto: 'Claro! Pode me dizer o que deseja?', from_me: true, status: 'read', operador_id: ctx.usuario_id, created_at: new Date(now - 35 * 60000) },
    { id: uuidv4(), empresa_id, conversa_id: conv2.id, direcao: 'in', tipo: 'text', texto: 'Perfeito, obrigado!', from_me: false, status: 'delivered', created_at: new Date(now - 30 * 60000) },
  ])

  await audit(repos, ctx, 'seed', 'empresa', empresa_id, { produtos: prods.length, pedidos: pedidos.length, mesas: mesas.length })
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
    const repos = await getRepositories()
    const {
      categoriaRepo, produtoRepo, clienteRepo, usuarioRepo, transacaoRepo,
      auditoriaRepo, integracaoRepo, mesaRepo, conversaRepo, mensagemRepo,
      pedidoRepo, comandaRepo, pagamentoRepo, empresaRepo, webhookEventsRepo,
    } = repos

    /* -------- health / meta -------- */
    if (route === '/' || route === '/health') {
      return json({
        service: 'restaurant-os',
        status: 'ok',
        // `database` e o backend REALMENTE em uso nesta requisicao; o bloco
        // `providers.supabase` continua indicando apenas se ha credenciais
        // configuradas (que nao implica que o Supabase seja o runtime ativo).
        database: getProviderName(),
        providers: { supabase: supabaseProviderStatus() },
      })
    }

    /* ==================== AUTH ==================== */
    if (route === '/auth/register' && method === 'POST') {
      const body = await request.json()
      const { empresa_nome, nome, email, senha } = body || {}
      if (!empresa_nome || !nome || !email || !senha) return err('Campos obrigatorios: empresa_nome, nome, email, senha')
      const emailNorm = String(email).toLowerCase().trim()
      const exists = await usuarioRepo.findByEmail(emailNorm)
      if (exists) return err('E-mail ja cadastrado', 409)

      const empresa_id = uuidv4()
      let slug = slugify(empresa_nome)
      if (await empresaRepo.findBySlug(slug)) slug = `${slug}-${empresa_id.slice(0, 6)}`
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
      await empresaRepo.create(empresa)

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
      await usuarioRepo.create(usuario)

      const ctx = { empresa_id, usuario_id, nome, papel: 'OWNER' }
      await seedEmpresa(repos, empresa_id, ctx)
      await audit(repos, ctx, 'register', 'empresa', empresa_id, { empresa_nome })

      const token = signToken({ usuario_id, empresa_id, papel: 'OWNER' })
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS.OWNER })
    }

    if (route === '/auth/login' && method === 'POST') {
      const { email, senha } = (await request.json()) || {}
      if (!email || !senha) return err('E-mail e senha obrigatorios')
      const usuario = await usuarioRepo.findByEmail(String(email).toLowerCase().trim())
      if (!usuario || !verifyPassword(senha, usuario.senha_hash)) return err('Credenciais invalidas', 401)
      if (!usuario.ativo) return err('Usuario inativo', 403)
      const empresa = await empresaRepo.findById(usuario.empresa_id)
      const token = signToken({ usuario_id: usuario.id, empresa_id: usuario.empresa_id, papel: usuario.papel })
      await audit(repos, { empresa_id: usuario.empresa_id, usuario_id: usuario.id, nome: usuario.nome }, 'login', 'usuario', usuario.id)
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS[usuario.papel] || [] })
    }

    /* ==================== WEBHOOK MERCADO PAGO (pre-auth, assinado) ==================== */
    if (route === '/pagamentos/webhook/mercadopago' && method === 'POST') {
      const url = new URL(request.url)
      const empresaId = url.searchParams.get('tenant')
      const dataId = url.searchParams.get('data.id') || url.searchParams.get('id')
      if (!empresaId || !dataId) return json({ error: 'params ausentes' }, 400)
      const integ = await integracaoRepo.findByTipo(empresaId, 'mercadopago')
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
      const dedupe = await webhookEventsRepo.upsert(empresaId, eventKey, 'mercadopago')
      if (!dedupe.isNew) return json({ ok: true, duplicated: true })
      // busca status autoritativo no gateway
      let statusInfo
      try { statusInfo = await provider.getStatus(dataId) } catch { return json({ ok: true }) }
      await pagamentoRepo.atualizarStatusPorProviderPaymentId(empresaId, 'mercadopago', String(dataId), statusInfo.status)
      return json({ ok: true, status: statusInfo.status })
    }

    /* ==================== WEBHOOK WHATSAPP (Evolution, pre-auth) ==================== */
    if (route === '/whatsapp/webhook' && method === 'POST') {
      const url = new URL(request.url)
      const empresaId = url.searchParams.get('tenant')
      const body = (await request.json().catch(() => ({}))) || {}
      if (!empresaId) return json({ ok: true, ignored: 'no-tenant' })
      const data = body.data || body
      const key = data.key || {}
      if (key.fromMe) return json({ ok: true, ignored: 'from_me' }) // apenas inbound
      const remoteJid = key.remoteJid || data.remoteJid || ''
      const numero = String(remoteJid).split('@')[0].replace(/\D/g, '')
      if (!numero) return json({ ok: true, ignored: 'no-number' })
      const nome = data.pushName || `Cliente ${numero.slice(-4)}`
      const msg = data.message || {}
      const tipo = data.messageType || (msg.imageMessage ? 'image' : msg.audioMessage ? 'audio' : msg.documentMessage ? 'document' : 'text')
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.documentMessage?.caption || (tipo !== 'text' ? `[${tipo}]` : '')
      // localiza/cria cliente por telefone (multitenant)
      let cliente = await clienteRepo.findByTelefone(empresaId, numero)
      if (!cliente) {
        cliente = { id: uuidv4(), empresa_id: empresaId, nome, telefone: numero, email: '', endereco: '', observacoes: '', total_pedidos: 0, total_gasto: 0, created_at: new Date() }
        await clienteRepo.create(cliente)
      }
      // localiza/cria conversa
      let conversa = await conversaRepo.findByContatoNumero(empresaId, numero)
      if (!conversa) {
        conversa = { id: uuidv4(), empresa_id: empresaId, cliente_id: cliente.id, contato_nome: cliente.nome || nome, contato_numero: numero, status: 'AGUARDANDO_EQUIPE', ultima_mensagem: texto, ultima_mensagem_em: new Date(), nao_lidas: 1, operador_id: null, pedido_ativo_id: null, created_at: new Date(), updated_at: new Date() }
        await conversaRepo.create(conversa)
        await audit(repos, { empresa_id: empresaId, usuario_id: null, nome: 'WhatsApp' }, 'criar', 'conversa', conversa.id, { numero })
      } else {
        await conversaRepo.incrementarNaoLidas(empresaId, conversa.id, { ultima_mensagem: texto, ultima_mensagem_em: new Date(), status: 'AGUARDANDO_EQUIPE', updated_at: new Date() })
      }
      await mensagemRepo.create({ empresa_id: empresaId, conversa_id: conversa.id, direcao: 'in', tipo, texto, media_url: null, from_me: false, status: 'delivered', provider_message_id: key.id || null })
      return json({ ok: true })
    }

    /* ---- a partir daqui, tudo autenticado ---- */
    const session = await auth(request)
    if (!session) return err('Nao autorizado', 401)
    const usuario = await usuarioRepo.findById(session.empresa_id, session.usuario_id)
    if (!usuario || !usuario.ativo) return err('Sessao invalida', 401)
    const ctx = { empresa_id: session.empresa_id, usuario_id: session.usuario_id, nome: usuario.nome, papel: usuario.papel }
    const tenant = { empresa_id: ctx.empresa_id } // escopo multitenant obrigatorio

    if (route === '/auth/me' && method === 'GET') {
      const empresa = await empresaRepo.findById(ctx.empresa_id)
      return json({ usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS[usuario.papel] || [], roles: ROLES })
    }

    /* ==================== EMPRESA ==================== */
    if (route === '/empresa' && method === 'GET') {
      return json(clean(await empresaRepo.findById(ctx.empresa_id)))
    }
    if (route === '/empresa' && method === 'PUT') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const current = await empresaRepo.findById(ctx.empresa_id)
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
      const atualizada = await empresaRepo.update(ctx.empresa_id, upd)
      await audit(repos, ctx, 'update', 'empresa', ctx.empresa_id, { campos: Object.keys(upd) })
      return json(clean(atualizada))
    }

    /* ==================== USUARIOS ==================== */
    if (route === '/usuarios' && method === 'GET') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const list = await usuarioRepo.list(ctx.empresa_id)
      return json(list.map(clean))
    }
    if (route === '/usuarios' && method === 'POST') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome || !b.email || !b.senha) return err('nome, email e senha obrigatorios')
      const emailNorm = String(b.email).toLowerCase().trim()
      if (await usuarioRepo.findByEmail(emailNorm)) return err('E-mail ja cadastrado', 409)
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
      await usuarioRepo.create(novo)
      await audit(repos, ctx, 'create', 'usuario', novo.id, { email: emailNorm, papel: novo.papel })
      return json(clean(novo), 201)
    }
    if (seg[0] === 'usuarios' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'papel', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.senha) upd.senha_hash = hashPassword(b.senha)
      const atualizado = await usuarioRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'usuario', seg[1], upd)
      return json(clean(atualizado))
    }
    if (seg[0] === 'usuarios' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'usuarios')) return err('Sem permissao', 403)
      if (seg[1] === ctx.usuario_id) return err('Voce nao pode remover a si mesmo', 400)
      await usuarioRepo.delete(ctx.empresa_id, seg[1])
      await audit(repos, ctx, 'delete', 'usuario', seg[1])
      return json({ ok: true })
    }

    /* ==================== CATEGORIAS ==================== */
    if (route === '/categorias' && method === 'GET') {
      const list = await categoriaRepo.list(ctx.empresa_id)
      return json(list.map(clean))
    }
    if (route === '/categorias' && method === 'POST') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome) return err('nome obrigatorio')
      const doc = { id: uuidv4(), empresa_id: ctx.empresa_id, nome: b.nome, ordem: b.ordem ?? 99, ativo: true, created_at: new Date() }
      await categoriaRepo.create(doc)
      await audit(repos, ctx, 'create', 'categoria', doc.id, { nome: b.nome })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'categorias' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'ordem', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      const atualizado = await categoriaRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'categoria', seg[1], upd)
      return json(clean(atualizado))
    }
    if (seg[0] === 'categorias' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      await categoriaRepo.delete(ctx.empresa_id, seg[1])
      await produtoRepo.deleteManyByCategoria(ctx.empresa_id, seg[1])
      await audit(repos, ctx, 'delete', 'categoria', seg[1])
      return json({ ok: true })
    }

    /* ==================== PRODUTOS ==================== */
    if (route === '/produtos' && method === 'GET') {
      const list = await produtoRepo.list(ctx.empresa_id)
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
      await produtoRepo.create(doc)
      await audit(repos, ctx, 'create', 'produto', doc.id, { nome: b.nome, preco: doc.preco })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'produtos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['categoria_id', 'nome', 'descricao', 'imagem', 'disponivel', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.preco !== undefined) upd.preco = Number(b.preco)
      const atualizado = await produtoRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'produto', seg[1], upd)
      return json(clean(atualizado))
    }
    if (seg[0] === 'produtos' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      await produtoRepo.delete(ctx.empresa_id, seg[1])
      await audit(repos, ctx, 'delete', 'produto', seg[1])
      return json({ ok: true })
    }

    /* ==================== CLIENTES ==================== */
    if (route === '/clientes' && method === 'GET') {
      const list = await clienteRepo.list(ctx.empresa_id)
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
      await clienteRepo.create(doc)
      await audit(repos, ctx, 'create', 'cliente', doc.id, { nome: b.nome })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'clientes' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'clientes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      for (const k of ['nome', 'telefone', 'email', 'endereco', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      const atualizado = await clienteRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'cliente', seg[1], upd)
      return json(clean(atualizado))
    }
    if (seg[0] === 'clientes' && seg[1] && method === 'DELETE') {
      if (!can(ctx.papel, 'clientes')) return err('Sem permissao', 403)
      await clienteRepo.delete(ctx.empresa_id, seg[1])
      await audit(repos, ctx, 'delete', 'cliente', seg[1])
      return json({ ok: true })
    }

    /* ==================== PEDIDOS ==================== */
    if (route === '/pedidos' && method === 'GET') {
      const url = new URL(request.url)
      const status = url.searchParams.get('status')
      const list = await pedidoRepo.listRecentes(ctx.empresa_id, status ? { status } : {}, 500)
      return json(list.map(clean))
    }
    if (route === '/pedidos' && method === 'POST') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const itens = Array.isArray(b.itens) ? b.itens : []
      if (!itens.length) return err('Pedido precisa de ao menos 1 item')
      const total = Math.round(itens.reduce((s, it) => s + Number(it.preco) * Number(it.quantidade || 1), 0) * 100) / 100
      const numero = await pedidoRepo.nextNumero(ctx.empresa_id)
      let cliente_nome = b.cliente_nome || 'Consumidor'
      if (b.cliente_id) {
        const c = await clienteRepo.findById(ctx.empresa_id, b.cliente_id)
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
      await pedidoRepo.create(doc)
      await audit(repos, ctx, 'create', 'pedido', doc.id, { numero, total })
      await emitEvent(repos, ctx, 'order.created', { pedido: clean(doc) })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'pedidos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const pedido = await pedidoRepo.findById(ctx.empresa_id, seg[1])
      if (!pedido) return err('Pedido nao encontrado', 404)
      const upd = { updated_at: new Date() }
      for (const k of ['status', 'tipo', 'pagamento', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      await pedidoRepo.update(ctx.empresa_id, seg[1], upd)

      // Regra de negocio: ao concluir/entregar, gera receita e atualiza metricas do cliente
      const finais = ['concluido', 'ENTREGUE']
      if (finais.includes(b.status) && !finais.includes(pedido.status)) {
        await transacaoRepo.create({
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
          await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, pedido.cliente_id, pedido.total)
        }
      }
      await audit(repos, ctx, 'update', 'pedido', seg[1], upd)
      if (b.status) await emitEvent(repos, ctx, 'order.status_changed', { pedido_id: seg[1], numero: pedido.numero, status: b.status })
      return json(clean(await pedidoRepo.findById(ctx.empresa_id, seg[1])))
    }

    /* ==================== FINANCEIRO ==================== */
    if (route === '/financeiro/transacoes' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const list = await transacaoRepo.listRecentes(ctx.empresa_id, 500)
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
      await transacaoRepo.create(doc)
      await audit(repos, ctx, 'create', 'transacao', doc.id, { tipo: doc.tipo, valor: doc.valor })
      return json(clean(doc), 201)
    }
    if (route === '/financeiro/resumo' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const list = await transacaoRepo.list(ctx.empresa_id)
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
        pedidoRepo.list(ctx.empresa_id),
        transacaoRepo.list(ctx.empresa_id),
        produtoRepo.list(ctx.empresa_id),
        clienteRepo.count(ctx.empresa_id),
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
      const list = await auditoriaRepo.list(ctx.empresa_id, 200)
      return json(list.map(clean))
    }

    /* ==================== INTEGRACOES ==================== */
    if (route === '/integracoes' && method === 'GET') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const list = await integracaoRepo.list(ctx.empresa_id)
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
      const current = await integracaoRepo.findByTipo(ctx.empresa_id, 'mercadopago')
      const config = {
        mode: b.mode || current?.config?.mode || 'sandbox',
        // mantem token existente se vier vazio (permite editar outros campos sem reenviar)
        accessToken: b.accessToken !== undefined && b.accessToken !== '' ? b.accessToken : current?.config?.accessToken || '',
        webhookSecret: b.webhookSecret !== undefined && b.webhookSecret !== '' ? b.webhookSecret : current?.config?.webhookSecret || '',
      }
      const status = config.accessToken ? 'configurado' : 'nao_configurado'
      await integracaoRepo.upsert(ctx.empresa_id, 'mercadopago', { config, status })
      await audit(repos, ctx, 'update', 'integracao', 'mercadopago', { status, mode: config.mode })
      return json({ ok: true, status, mode: config.mode, hasAccessToken: Boolean(config.accessToken) })
    }
    if (route === '/integracoes/evolution' && method === 'PUT') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const config = { serverUrl: b.serverUrl || '', apiKey: b.apiKey || '', instance: b.instance || 'restaurant-os' }
      const status = config.serverUrl && config.apiKey ? 'configurado' : 'nao_configurado'
      const atualizado = await integracaoRepo.upsert(ctx.empresa_id, 'evolution', { config, status })
      await audit(repos, ctx, 'update', 'integracao', 'evolution', { status })
      return json(clean(atualizado))
    }
    if (route === '/integracoes/n8n' && method === 'PUT') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const config = { webhookUrl: b.webhookUrl || '', apiKey: b.apiKey || '', eventos: b.eventos || ['order.created', 'order.status_changed'] }
      const status = config.webhookUrl ? 'configurado' : 'nao_configurado'
      const atualizado = await integracaoRepo.upsert(ctx.empresa_id, 'n8n', { config, status })
      await audit(repos, ctx, 'update', 'integracao', 'n8n', { status })
      return json(clean(atualizado))
    }
    if (route === '/integracoes/evolution/testar' && method === 'POST') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const integ = await integracaoRepo.findByTipo(ctx.empresa_id, 'evolution')
      const result = await fetchInstanceStatus(integ?.config || {})
      return json(result)
    }
    if (route === '/integracoes/n8n/testar' && method === 'POST') {
      if (!can(ctx.papel, 'integracoes')) return err('Sem permissao', 403)
      const integ = await integracaoRepo.findByTipo(ctx.empresa_id, 'n8n')
      const result = await testN8nConnection(integ?.config || {})
      return json(result)
    }

    /* ==================== MESAS (salao) ==================== */
    if (route === '/mesas' && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const mesas = await mesaRepo.list(ctx.empresa_id, { ativo: true })
      // anexa resumo da comanda aberta
      const comandaIds = mesas.map((m) => m.comanda_id).filter(Boolean)
      const comandas = comandaIds.length ? await comandaRepo.findManyByIds(ctx.empresa_id, comandaIds) : []
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
      const existentes = await mesaRepo.list(ctx.empresa_id)
      const maxNum = existentes.reduce((mx, m) => Math.max(mx, m.numero), 0)
      const novas = []
      for (let n = existentes.length + 1; n <= quantidade; n++) {
        const numero = Math.max(n, maxNum + 1) // garante numeracao unica crescente
        novas.push({ id: uuidv4(), empresa_id: ctx.empresa_id, numero: n, nome: `Mesa ${padMesa(n)}`, capacidade, status: 'livre', comanda_id: null, ativo: true, created_at: new Date(), updated_at: new Date() })
      }
      if (novas.length) await mesaRepo.createMany(novas)
      // se reduzir: desativa mesas livres excedentes (nunca remove com comanda aberta)
      if (quantidade < existentes.length) {
        const excedentes = existentes.filter((m) => m.numero > quantidade && m.status === 'livre')
        for (const m of excedentes) await mesaRepo.update(ctx.empresa_id, m.id, { ativo: false, updated_at: new Date() })
      }
      await audit(repos, ctx, 'configurar', 'mesas', ctx.empresa_id, { quantidade, capacidade })
      const mesas = await mesaRepo.list(ctx.empresa_id, { ativo: true })
      return json(mesas.map(clean))
    }
    if (seg[0] === 'mesas' && seg[1] && seg[2] === 'abrir' && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const mesa = await mesaRepo.findById(ctx.empresa_id, seg[1])
      if (!mesa) return err('Mesa nao encontrada', 404)
      if (mesa.comanda_id) return err('Mesa ja possui comanda aberta', 409)
      const b = (await request.json()) || {}
      let cliente_nome = b.cliente_nome || 'Cliente'
      if (b.cliente_id) {
        const c = await clienteRepo.findById(ctx.empresa_id, b.cliente_id)
        if (c) cliente_nome = c.nome
      }
      const emp = await empresaRepo.findById(ctx.empresa_id)
      const comanda = {
        id: uuidv4(), empresa_id: ctx.empresa_id, mesa_id: mesa.id, mesa_nome: mesa.nome,
        cliente_id: b.cliente_id || null, cliente_nome, pessoas: Number(b.pessoas || 1), status: 'aberta',
        itens: [], desconto: 0, desconto_tipo: 'valor', taxa_servico_percent: Number(emp?.config?.pagamentos?.taxa_servico_padrao ?? 10),
        pagamentos: [], operador_id: ctx.usuario_id, operador_nome: ctx.nome,
        aberta_em: new Date(), fechada_em: null, created_at: new Date(), updated_at: new Date(),
      }
      Object.assign(comanda, computeComanda(comanda))
      await comandaRepo.create(comanda)
      await mesaRepo.update(ctx.empresa_id, mesa.id, { status: 'ocupada', comanda_id: comanda.id, updated_at: new Date() })
      await audit(repos, ctx, 'abrir', 'comanda', comanda.id, { mesa: mesa.nome })
      return json(clean(comanda), 201)
    }
    if (seg[0] === 'mesas' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = { updated_at: new Date() }
      for (const k of ['nome', 'capacidade']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.status !== undefined && MESA_STATUS.includes(b.status)) upd.status = b.status
      const atualizada = await mesaRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'mesa', seg[1], upd)
      return json(clean(atualizada))
    }

    /* ==================== COMANDAS ==================== */
    const reloadComanda = async (id) => {
      const c = await comandaRepo.findById(ctx.empresa_id, id)
      if (!c) return null
      const derivados = computeComanda(c)
      Object.assign(c, derivados)
      await comandaRepo.setDerivados(ctx.empresa_id, id, derivados)
      if (c.mesa_id) {
        const mesaStatus = c.restante <= 0 && c.total > 0 ? 'aguardando_pagamento' : 'ocupada'
        await mesaRepo.syncStatusOcupada(ctx.empresa_id, c.mesa_id, mesaStatus)
      }
      return c
    }
    if (route === '/comandas' && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const url = new URL(request.url)
      const status = url.searchParams.get('status')
      const list = await comandaRepo.list(ctx.empresa_id, status ? { status } : {})
      return json(list.map(clean))
    }
    if (seg[0] === 'comandas' && seg[1] && seg.length === 2 && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const c = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!c) return err('Comanda nao encontrada', 404)
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && !seg[3] && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      let nome = b.nome, preco = b.preco
      if (b.produto_id) {
        const p = await produtoRepo.findById(ctx.empresa_id, b.produto_id)
        if (p) { nome = p.nome; preco = p.preco }
      }
      if (!nome || preco === undefined) return err('produto invalido')
      const item = { id: uuidv4(), produto_id: b.produto_id || null, nome, preco: Number(preco), quantidade: Number(b.quantidade || 1), observacao: b.observacao || '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() }
      await comandaRepo.pushItem(ctx.empresa_id, seg[1], item)
      const c = await reloadComanda(seg[1])
      await audit(repos, ctx, 'add_item', 'comanda', seg[1], { item: nome, quantidade: item.quantidade })
      return json(clean(c), 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && seg[3] && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const patch = {}
      if (b.quantidade !== undefined) patch.quantidade = Number(b.quantidade)
      if (b.observacao !== undefined) patch.observacao = b.observacao
      await comandaRepo.updateItemCampos(ctx.empresa_id, seg[1], seg[3], patch)
      const c = await reloadComanda(seg[1])
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'itens' && seg[3] && method === 'DELETE') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      await comandaRepo.removeItem(ctx.empresa_id, seg[1], seg[3])
      const c = await reloadComanda(seg[1])
      await audit(repos, ctx, 'remove_item', 'comanda', seg[1], { item_id: seg[3] })
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg.length === 2 && method === 'PUT') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const set = { updated_at: new Date() }
      for (const k of ['pessoas', 'desconto', 'desconto_tipo', 'taxa_servico_percent', 'cliente_id', 'cliente_nome']) if (b[k] !== undefined) set[k] = b[k]
      await comandaRepo.update(ctx.empresa_id, seg[1], set)
      const c = await reloadComanda(seg[1])
      await audit(repos, ctx, 'update', 'comanda', seg[1], set)
      return json(clean(c))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'transferir' && method === 'POST') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const destino = await mesaRepo.findById(ctx.empresa_id, b.mesa_id)
      if (!destino) return err('Mesa destino nao encontrada', 404)
      if (destino.comanda_id) return err('Mesa destino ocupada', 409)
      // libera mesa origem
      if (comanda.mesa_id) await mesaRepo.update(ctx.empresa_id, comanda.mesa_id, { status: 'livre', comanda_id: null, updated_at: new Date() })
      await mesaRepo.update(ctx.empresa_id, destino.id, { status: 'ocupada', comanda_id: comanda.id, updated_at: new Date() })
      const atualizada = await comandaRepo.update(ctx.empresa_id, comanda.id, { mesa_id: destino.id, mesa_nome: destino.nome, updated_at: new Date() })
      await audit(repos, ctx, 'transferir', 'comanda', comanda.id, { de: comanda.mesa_nome, para: destino.nome })
      return json(clean(atualizada))
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'pagamentos' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const comanda = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      if (!b.metodo || b.valor === undefined) return err('metodo e valor obrigatorios')
      // pagamento manual (dinheiro/cartao/pix presencial) -> aprovado
      const pagamento = {
        id: uuidv4(), empresa_id: ctx.empresa_id, comanda_id: comanda.id, pedido_id: null,
        metodo: b.metodo, valor: Number(b.valor), status: 'approved', provider: 'manual',
        provider_payment_id: null, external_reference: comanda.id, idempotency_key: uuidv4(),
        created_at: new Date(), updated_at: new Date(),
      }
      await pagamentoRepo.create(pagamento) // fonte de verdade (sem delete fisico)
      await comandaRepo.pushPagamentoResumo(ctx.empresa_id, comanda.id, { id: pagamento.id, metodo: pagamento.metodo, valor: pagamento.valor, status: 'approved', provider: 'manual', created_at: pagamento.created_at })
      const c = await reloadComanda(comanda.id)
      await audit(repos, ctx, 'pagamento', 'comanda', comanda.id, { metodo: b.metodo, valor: pagamento.valor })
      return json(clean(c), 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'pix' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const comanda = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const integ = await integracaoRepo.findByTipo(ctx.empresa_id, 'mercadopago')
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
      await pagamentoRepo.create(pagamento)
      await audit(repos, ctx, 'pix_criado', 'comanda', comanda.id, { valor, provider_payment_id: result.providerPaymentId })
      return json({ id: pagamento.id, status: pagamento.status, valor, qr_code: result.qrCode, qr_code_base64: result.qrCodeBase64, ticket_url: result.ticketUrl }, 201)
    }
    if (seg[0] === 'comandas' && seg[1] && seg[2] === 'fechar' && method === 'POST') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const comanda = await comandaRepo.findById(ctx.empresa_id, seg[1])
      if (!comanda || comanda.status !== 'aberta') return err('Comanda nao esta aberta', 400)
      const totals = computeComanda(comanda)
      const b = (await request.json().catch(() => ({}))) || {}
      if (!b.forcar && totals.restante > 0.009) return err(`Restam ${totals.restante} a pagar`, 400)
      // cria pedido (tipo mesa, concluido) para integrar dashboard/financeiro
      const numero = await pedidoRepo.nextNumero(ctx.empresa_id)
      const pedido = {
        id: uuidv4(), empresa_id: ctx.empresa_id, numero, cliente_id: comanda.cliente_id, cliente_nome: comanda.cliente_nome,
        itens: (comanda.itens || []).map((i) => ({ produto_id: i.produto_id, nome: i.nome, preco: i.preco, quantidade: i.quantidade })),
        tipo: 'mesa', pagamento: (comanda.pagamentos?.[0]?.metodo) || 'dinheiro', status: 'concluido',
        observacoes: `Comanda ${comanda.mesa_nome}`, comanda_id: comanda.id, total: totals.total,
        created_at: new Date(), updated_at: new Date(),
      }
      await pedidoRepo.create(pedido)
      await transacaoRepo.create({
        id: uuidv4(), empresa_id: ctx.empresa_id, tipo: 'receita', categoria: 'Vendas',
        descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero})`, valor: totals.total, pedido_id: pedido.id, comanda_id: comanda.id,
        data: new Date(), created_at: new Date(),
      })
      if (comanda.cliente_id) await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, comanda.cliente_id, totals.total)
      await comandaRepo.update(ctx.empresa_id, comanda.id, { status: 'fechada', fechada_em: new Date(), total: totals.total, updated_at: new Date() })
      if (comanda.mesa_id) await mesaRepo.update(ctx.empresa_id, comanda.mesa_id, { status: 'livre', comanda_id: null, updated_at: new Date() })
      await audit(repos, ctx, 'fechar', 'comanda', comanda.id, { total: totals.total, pedido: numero })
      await emitEvent(repos, ctx, 'comanda.closed', { comanda_id: comanda.id, total: totals.total })
      return json({ ok: true, pedido_numero: numero, total: totals.total })
    }

    /* ==================== PAGAMENTOS (status) ==================== */
    if (seg[0] === 'pagamentos' && seg[1] && seg.length === 2 && method === 'GET') {
      if (!can(ctx.papel, 'pagamentos')) return err('Sem permissao', 403)
      const p = await pagamentoRepo.findById(ctx.empresa_id, seg[1])
      if (!p) return err('Pagamento nao encontrado', 404)
      // se pix mercadopago pendente, consulta status autoritativo
      if (p.provider === 'mercadopago' && p.status === 'pending' && p.provider_payment_id) {
        const integ = await integracaoRepo.findByTipo(ctx.empresa_id, 'mercadopago')
        if (integ && isGatewayConfigured('mercadopago', integ.config)) {
          try {
            const st = await getPaymentProvider('mercadopago', integ.config).getStatus(p.provider_payment_id)
            if (st.status !== p.status) { await pagamentoRepo.update(ctx.empresa_id, p.id, { status: st.status, updated_at: new Date() }); p.status = st.status }
          } catch { /* ignora */ }
        }
      }
      const { _id, ...rest } = p
      return json(rest)
    }

    /* ==================== ATENDIMENTO / CONVERSAS ==================== */
    const normPedidoStatus = (s) => {
      if (['recebido', 'NOVO', 'CONFIRMADO'].includes(s)) return 'novo'
      if (['em_preparo', 'EM_PREPARACAO'].includes(s)) return 'em_preparacao'
      if (['pronto', 'PRONTO'].includes(s)) return 'pronto'
      if (['SAIU_PARA_ENTREGA'].includes(s)) return 'saiu'
      if (['concluido', 'ENTREGUE'].includes(s)) return 'entregue'
      if (['cancelado', 'CANCELADO'].includes(s)) return 'cancelado'
      return 'novo'
    }
    const pedidoAtivoDoCliente = (pedidos, cliente_id) => {
      const doCliente = pedidos.filter((p) => p.cliente_id === cliente_id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      if (!doCliente.length) return { has: false, pedido: null }
      const ativo = doCliente.find((p) => !['concluido', 'ENTREGUE', 'cancelado', 'CANCELADO'].includes(p.status))
      return { has: true, pedido: ativo || doCliente[0] }
    }
    if (route === '/conversas/metrics' && method === 'GET') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const [convs, pedidos] = await Promise.all([
        conversaRepo.list(ctx.empresa_id),
        pedidoRepo.list(ctx.empresa_id),
      ])
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const byStatus = (s) => convs.filter((c) => c.status === s).length
      const resolvidas = convs.filter((c) => c.status === 'RESOLVIDA' && c.created_at && c.updated_at)
      const tempoMedioMin = resolvidas.length ? Math.round(resolvidas.reduce((s, c) => s + (new Date(c.updated_at) - new Date(c.created_at)), 0) / resolvidas.length / 60000) : 0
      return json({
        abertas: byStatus('ABERTA'), aguardando_equipe: byStatus('AGUARDANDO_EQUIPE'), aguardando_cliente: byStatus('AGUARDANDO_CLIENTE'), resolvidas: byStatus('RESOLVIDA'),
        nao_lidas: convs.reduce((s, c) => s + (c.nao_lidas || 0), 0),
        pedidos_andamento: pedidos.filter((p) => !['concluido', 'ENTREGUE', 'cancelado', 'CANCELADO'].includes(p.status)).length,
        pedidos_prontos: pedidos.filter((p) => normPedidoStatus(p.status) === 'pronto').length,
        pedidos_entrega: pedidos.filter((p) => normPedidoStatus(p.status) === 'saiu').length,
        pedidos_entregues_hoje: pedidos.filter((p) => normPedidoStatus(p.status) === 'entregue' && new Date(p.updated_at) >= today).length,
        tempo_medio_min: tempoMedioMin,
      })
    }
    if (route === '/conversas' && method === 'GET') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const url = new URL(request.url)
      const fStatus = url.searchParams.get('status')
      const fPedido = url.searchParams.get('pedido_status')
      const q = (url.searchParams.get('q') || '').toLowerCase()
      const [convsAll, pedidos] = await Promise.all([
        conversaRepo.list(ctx.empresa_id),
        pedidoRepo.list(ctx.empresa_id),
      ])
      let convs = convsAll.map((c) => {
        const at = pedidoAtivoDoCliente(pedidos, c.cliente_id)
        return { ...clean(c), pedido: at.pedido ? { id: at.pedido.id, numero: at.pedido.numero, status: at.pedido.status, status_norm: normPedidoStatus(at.pedido.status), total: at.pedido.total } : null, tem_pedido: at.has }
      })
      if (fStatus && fStatus !== 'todas') {
        if (fStatus === 'nao_lidas') convs = convs.filter((c) => (c.nao_lidas || 0) > 0)
        else convs = convs.filter((c) => c.status === fStatus)
      }
      if (fPedido && fPedido !== 'todos') {
        if (fPedido === 'sem_pedido') convs = convs.filter((c) => !c.tem_pedido)
        else convs = convs.filter((c) => c.pedido && c.pedido.status_norm === fPedido)
      }
      if (q) convs = convs.filter((c) => (c.contato_nome || '').toLowerCase().includes(q) || (c.contato_numero || '').includes(q) || (c.pedido && String(c.pedido.numero).includes(q)))
      return json(convs)
    }
    if (seg[0] === 'conversas' && seg[1] && seg.length === 2 && method === 'GET') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const conversa = await conversaRepo.findById(ctx.empresa_id, seg[1])
      if (!conversa) return err('Conversa nao encontrada', 404)
      const cliente = conversa.cliente_id ? await clienteRepo.findById(ctx.empresa_id, conversa.cliente_id) : null
      const pedidos = await pedidoRepo.findByCliente(ctx.empresa_id, conversa.cliente_id)
      const at = pedidoAtivoDoCliente(pedidos, conversa.cliente_id)
      const ultimoPedido = pedidos[0] || null
      return json({
        conversa: clean(conversa),
        cliente: clean(cliente),
        pedido_ativo: at.pedido ? { ...clean(at.pedido), status_norm: normPedidoStatus(at.pedido.status) } : null,
        historico: { total_pedidos: pedidos.length, ticket_medio: cliente?.total_pedidos ? round2((cliente.total_gasto || 0) / cliente.total_pedidos) : 0, ultimo_pedido: ultimoPedido?.created_at || null },
      })
    }
    if (seg[0] === 'conversas' && seg[1] && seg[2] === 'mensagens' && method === 'GET') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const list = await mensagemRepo.list(ctx.empresa_id, seg[1])
      return json(list.map(clean))
    }
    if (seg[0] === 'conversas' && seg[1] && seg[2] === 'mensagens' && method === 'POST') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.texto) return err('texto obrigatorio')
      const conversa = await conversaRepo.findById(ctx.empresa_id, seg[1])
      if (!conversa) return err('Conversa nao encontrada', 404)
      const integ = await integracaoRepo.findByTipo(ctx.empresa_id, 'evolution')
      if (!integ || !(integ.config?.serverUrl && integ.config?.apiKey)) return err('Evolution API nao configurada', 400)
      try {
        await sendWhatsappMessage(integ.config, { to: conversa.contato_numero, message: b.texto })
      } catch (e) { return err(`Falha ao enviar: ${e.message}`, 502) }
      const mensagem = await mensagemRepo.create({ empresa_id: ctx.empresa_id, conversa_id: conversa.id, direcao: 'out', tipo: 'text', texto: b.texto, media_url: null, from_me: true, status: 'sent', provider_message_id: null, operador_id: ctx.usuario_id })
      await conversaRepo.update(ctx.empresa_id, conversa.id, { ultima_mensagem: b.texto, ultima_mensagem_em: new Date(), status: 'AGUARDANDO_CLIENTE', nao_lidas: 0, operador_id: ctx.usuario_id, updated_at: new Date() })
      await audit(repos, ctx, 'mensagem', 'conversa', conversa.id, {})
      return json(clean(mensagem), 201)
    }
    if (seg[0] === 'conversas' && seg[1] && seg[2] === 'ler' && method === 'POST') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      await conversaRepo.update(ctx.empresa_id, seg[1], { nao_lidas: 0 })
      return json({ ok: true })
    }
    if (seg[0] === 'conversas' && seg[1] && seg.length === 2 && method === 'PUT') {
      if (!can(ctx.papel, 'atendimento')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const set = { updated_at: new Date() }
      const STATUS_CONV = ['ABERTA', 'AGUARDANDO_EQUIPE', 'AGUARDANDO_CLIENTE', 'RESOLVIDA']
      if (b.status && STATUS_CONV.includes(b.status)) set.status = b.status
      if (b.operador_id !== undefined) set.operador_id = b.operador_id
      if (b.pedido_ativo_id !== undefined) set.pedido_ativo_id = b.pedido_ativo_id
      const atualizada = await conversaRepo.update(ctx.empresa_id, seg[1], set)
      await audit(repos, ctx, 'update', 'conversa', seg[1], set)
      return json(clean(atualizada))
    }

    /* ==================== RELATORIO FINANCEIRO (dados reais) ==================== */
    if (route === '/financeiro/relatorio' && method === 'GET') {
      if (!can(ctx.papel, 'relatorios') && !can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const url = new URL(request.url)
      const now = new Date()
      const inicio = url.searchParams.get('inicio') ? new Date(url.searchParams.get('inicio')) : new Date(now.getTime() - 30 * 86400000)
      const fim = url.searchParams.get('fim') ? new Date(url.searchParams.get('fim')) : now
      inicio.setHours(0, 0, 0, 0); fim.setHours(23, 59, 59, 999)
      const fPag = url.searchParams.get('pagamento')
      const fStatus = url.searchParams.get('status')
      const fTipo = url.searchParams.get('tipo')
      const inRange = (d) => { const x = new Date(d); return x >= inicio && x <= fim }

      const [pedidosAll, transAll, pagsAll] = await Promise.all([
        pedidoRepo.list(ctx.empresa_id),
        transacaoRepo.list(ctx.empresa_id),
        pagamentoRepo.list(ctx.empresa_id),
      ])
      let pedidos = pedidosAll.filter((p) => inRange(p.created_at))
      if (fPag && fPag !== 'todos') pedidos = pedidos.filter((p) => p.pagamento === fPag)
      if (fStatus && fStatus !== 'todos') pedidos = pedidos.filter((p) => normPedidoStatus(p.status) === fStatus)
      if (fTipo && fTipo !== 'todos') pedidos = pedidos.filter((p) => p.tipo === fTipo)
      const trans = transAll.filter((t) => inRange(t.data))
      const pags = pagsAll.filter((p) => inRange(p.created_at))

      const faturados = pedidos.filter((p) => ['concluido', 'ENTREGUE'].includes(p.status))
      const cancelados = pedidos.filter((p) => ['cancelado', 'CANCELADO'].includes(p.status))
      const receitas = round2(trans.filter((t) => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0))
      const despesas = round2(trans.filter((t) => t.tipo === 'despesa').reduce((s, t) => s + t.valor, 0))
      const faturamentoBruto = round2(faturados.reduce((s, p) => s + p.total, 0))
      const recebidos = round2(pags.filter((p) => p.status === 'approved').reduce((s, p) => s + p.valor, 0))
      const pendentes = round2(pags.filter((p) => p.status === 'pending').reduce((s, p) => s + p.valor, 0))
      const reembolsados = round2(pags.filter((p) => ['refunded', 'cancelled'].includes(p.status)).reduce((s, p) => s + p.valor, 0))

      // series por dia (limitado a 92 dias)
      const dias = Math.min(92, Math.max(1, Math.ceil((fim - inicio) / 86400000)))
      const serie = []
      for (let i = 0; i < dias; i++) {
        const d0 = new Date(inicio.getTime() + i * 86400000); d0.setHours(0, 0, 0, 0)
        const d1 = new Date(d0.getTime() + 86400000)
        serie.push({
          dia: d0.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          faturamento: round2(trans.filter((t) => t.tipo === 'receita' && new Date(t.data) >= d0 && new Date(t.data) < d1).reduce((s, t) => s + t.valor, 0)),
          receita: round2(trans.filter((t) => t.tipo === 'receita' && new Date(t.data) >= d0 && new Date(t.data) < d1).reduce((s, t) => s + t.valor, 0)),
          despesa: round2(trans.filter((t) => t.tipo === 'despesa' && new Date(t.data) >= d0 && new Date(t.data) < d1).reduce((s, t) => s + t.valor, 0)),
          pedidos: pedidos.filter((p) => new Date(p.created_at) >= d0 && new Date(p.created_at) < d1).length,
        })
      }
      const porPagamento = {}
      for (const p of faturados) porPagamento[p.pagamento || 'outros'] = round2((porPagamento[p.pagamento || 'outros'] || 0) + p.total)
      const porFormaPagamento = Object.entries(porPagamento).map(([forma, valor]) => ({ forma, valor }))

      const tabela = pedidos.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 500).map((p) => ({
        data: p.created_at, numero: p.numero, cliente: p.cliente_nome, pagamento: p.pagamento, valor: p.total, status: p.status, origem: p.tipo,
      }))

      return json({
        periodo: { inicio, fim },
        kpis: {
          faturamento_bruto: faturamentoBruto,
          faturamento_liquido: round2(faturamentoBruto - despesas),
          total_pedidos: pedidos.length,
          ticket_medio: faturados.length ? round2(faturamentoBruto / faturados.length) : 0,
          receitas, despesas, saldo: round2(receitas - despesas),
          recebidos, pendentes, cancelados_reembolsados: round2(cancelados.reduce((s, p) => s + p.total, 0) + reembolsados),
        },
        serie, porFormaPagamento, tabela,
      })
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
