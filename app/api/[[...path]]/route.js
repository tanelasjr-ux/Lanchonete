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
import { supabaseProviderStatus, isSupabaseConfigured } from '@/lib/integrations/supabase'
import { uploadLogo, removeLogo, uploadCardapioImagem, removeCardapioImagem, isStorageConfigured } from '@/lib/integrations/storage'
import { getPaymentProvider, isGatewayConfigured, PAYMENT_METHODS, PAYMENT_GATEWAYS } from '@/lib/integrations/payments/provider'
import { capturarErro } from '@/lib/integrations/monitoring'
import { checarLimite, ipDoCliente } from '@/lib/rateLimit'
import { getRepositories, getProviderName } from '@/lib/repositories/factory'
import { computeCaixaEsperado } from '@/lib/caixa'
import { computeCustoVenda, computeCMV, computeMargemPorCanal, computeMargemPorProduto } from '@/lib/custo'
import { CATEGORIAS_DESPESA, agruparDespesasPorCategoria, computeDRE, computeVariacao, periodoAnterior } from '@/lib/financeiro'
import { statusEfetivo, resumoContas, adicionarMeses } from '@/lib/contas'
import { MODULOS, temModulo, flagsPadraoSignup, modulosAtivos } from '@/lib/modulos'
import { statusEfetivo as statusEfetivoAssinatura, avisoParaCliente, resumoCarteira } from '@/lib/assinatura'

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
 * aqui antes era um valor publico, versionado no proprio codigo).
 *
 * A checagem e LAZY (no primeiro uso, nao na carga do modulo) por um motivo
 * concreto: `next build` avalia este modulo para coletar dados das rotas, com
 * NODE_ENV=production e sem as variaveis de runtime — uma versao anterior
 * disto, avaliada no import, quebrava o build da imagem Docker. Assinar ou
 * verificar token so acontece em runtime, que e exatamente onde a exigencia
 * precisa valer.
 */
let _jwtSecret = null
function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret
  const s = process.env.JWT_SECRET
  if (s) { _jwtSecret = s; return _jwtSecret }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET e obrigatorio em producao — nao ha valor padrao seguro.')
  }
  _jwtSecret = 'ros_dev_secret_apenas_local'
  return _jwtSecret
}
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
  const sig = crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}
function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.')
    const expectedBuf = Buffer.from(crypto.createHmac('sha256', getJwtSecret()).update(`${header}.${body}`).digest('base64url'))
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
  // ATENDENTE opera o balcao e o salao — nao ve dinheiro do negocio.
  // `dashboard` saiu porque a tela expoe faturamento do dia, ticket medio e
  // alerta de estoque; `atendimento` saiu porque a central de conversas do
  // WhatsApp (delivery) e trabalho de quem cuida do canal, nao do balcao.
  // Decisao do dono em 2026-08-18, ao revisar o que a conta de atendente
  // enxergava. Continua com `pagamentos` porque precisa receber a venda.
  ATENDENTE: ['clientes', 'pedidos', 'mesas', 'pagamentos'],
  // COZINHA vai direto para o KDS (o front redireciona no login) e nunca abre
  // o Dashboard. `dashboard` saiu da lista pelo mesmo motivo do ATENDENTE:
  // enquanto estava aqui, o endpoint de metricas servia faturamento a quem
  // so precisa saber o que produzir.
  COZINHA: ['pedidos'],
}
function can(papel, modulo) {
  const perms = PERMISSIONS[papel] || []
  return perms.includes('*') || perms.includes(modulo)
}

/**
 * Vocabulario de tipo de pedido (migration 0024). `mesa` esta aqui porque
 * existe no banco, mas nao e criado por requisicao: nasce do fechamento de
 * comanda.
 */
const TIPOS_PEDIDO = ['delivery', 'mesa', 'para_levar']
/**
 * `balcao` e `retirada` foram fundidos em `para_levar`. Traduzir em vez de
 * recusar nao e leniencia: depois de um deploy o navegador de quem estava com
 * o app aberto continua servindo o JS antigo (armadilha conhecida, ver
 * HANDOFF §10) e mandaria `balcao` por horas. Recusar transformaria isso em
 * "nao consigo lancar pedido" no meio do expediente; traduzir grava o pedido
 * no vocabulario certo e ninguem perde venda.
 */
const TIPO_PEDIDO_LEGADO = { balcao: 'para_levar', retirada: 'para_levar' }
function normPedidoTipo(valor, padrao = 'para_levar') {
  if (!valor) return padrao
  if (TIPOS_PEDIDO.includes(valor)) return valor
  return TIPO_PEDIDO_LEGADO[valor] || padrao
}

/**
 * Normaliza o vocabulario duplo de pedidos.status (minusculo original +
 * MAIUSCULO do fluxo de atendimento/delivery v3 - ver migration 0002).
 * Em escopo de modulo (nao dentro de handler()) porque tanto rotas
 * autenticadas quanto o endpoint publico /kds/pendentes precisam dela.
 */
function normPedidoStatus(s) {
  if (['recebido', 'NOVO', 'CONFIRMADO'].includes(s)) return 'novo'
  if (['em_preparo', 'EM_PREPARACAO'].includes(s)) return 'em_preparacao'
  if (['pronto', 'PRONTO'].includes(s)) return 'pronto'
  if (['SAIU_PARA_ENTREGA'].includes(s)) return 'saiu'
  if (['concluido', 'ENTREGUE'].includes(s)) return 'entregue'
  if (['cancelado', 'CANCELADO'].includes(s)) return 'cancelado'
  return 'novo'
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
 * Valores de um pedido a partir do subtotal dos itens, com ajuste manual de
 * desconto e acrescimo (cortesia, arredondamento, taxa de entrega, acerto).
 *
 * Fonte unica de verdade desses numeros — vive aqui, no Service, nunca em
 * trigger nem em repository (ADR-006). Lanca em entrada invalida para que o
 * chamador devolva 400, em vez de gravar um valor sem sentido.
 */
function computePedidoValores(subtotal, descontoEntrada, acrescimoEntrada, entregaTaxaEntrada = 0) {
  const sub = round2(subtotal)
  const desconto = round2(descontoEntrada)
  const acrescimo = round2(acrescimoEntrada)
  const entrega_taxa = round2(entregaTaxaEntrada)

  if (!Number.isFinite(desconto) || desconto < 0) throw new Error('Desconto invalido')
  if (!Number.isFinite(acrescimo) || acrescimo < 0) throw new Error('Acrescimo invalido')
  if (!Number.isFinite(entrega_taxa) || entrega_taxa < 0) throw new Error('Taxa de entrega invalida')
  // Um pedido nao pode custar menos que zero: o desconto e limitado pelo que
  // ha para descontar (itens + acrescimo + taxa de entrega).
  if (desconto > sub + acrescimo + entrega_taxa) throw new Error('Desconto maior que o valor do pedido')

  return { subtotal: sub, desconto, acrescimo, entrega_taxa, total: round2(sub - desconto + acrescimo + entrega_taxa) }
}

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

/**
 * Monta o resumo financeiro de um caixa: quanto deveria haver na gaveta e o
 * total por forma de pagamento. Usado pelo GET /caixa/atual, pelo fechamento e
 * pela validacao de sangria — os tres precisam exatamente do mesmo numero.
 */
async function resumoDoCaixa(repos, empresaId, caixa) {
  const [transacoes, movimentos] = await Promise.all([
    repos.transacaoRepo.findByCaixa(empresaId, caixa.id),
    repos.caixaMovimentoRepo.listByCaixa(empresaId, caixa.id),
  ])
  return computeCaixaEsperado({
    valor_abertura: caixa.valor_abertura,
    transacoes,
    movimentos,
  })
}

/**
 * Monta o mapa `produto_id -> custo` para os itens de uma venda.
 *
 * Uma leitura de produtos por venda (nao uma por item): a lista inteira sai em
 * uma query e o filtro acontece em memoria, no mesmo espirito do que a baixa de
 * estoque ja faz logo abaixo de cada ponto de venda.
 *
 * Falha de leitura NAO derruba a venda: devolve mapa vazio, o que faz a
 * apuracao gravar `custo_total = 0` e `receita_com_custo = 0` mantendo
 * `receita_base` real. O efeito e a cobertura cair, que e exatamente o sinal
 * honesto — "esta venda nao teve custo apurado" — em vez de um numero inventado.
 */
async function mapaCustoProdutos(repos, ctx, itens) {
  try {
    const ids = [...new Set((itens || []).map((i) => i.produto_id).filter(Boolean))]
    if (ids.length === 0) return {}
    const todos = await repos.produtoRepo.list(ctx.empresa_id)
    const mapa = {}
    for (const p of todos) {
      if (ids.includes(p.id)) mapa[p.id] = p.custo ?? null
    }
    return mapa
  } catch (e) {
    console.warn(`Apuracao de custo falhou: ${e.message}`)
    await audit(repos, ctx, 'custo_erro', 'produto', null, { erro: e.message })
    return {}
  }
}

/**
 * Reage a QUALQUER pagamento assincrono (Pix ou Point) que acabou de mudar
 * de status — chamada pelo webhook do Mercado Pago (Pix), pelo webhook do
 * Point, e pelo polling de GET /pagamentos/:id. E o UNICO lugar que
 * sincroniza a comanda e lanca receita do pedido: sem essa centralizacao,
 * cada gateway reimplementaria a mesma logica e divergiria com o tempo
 * (mesmo raciocinio do achado #18 do HANDOFF — "if (!updated)" so vale se
 * TODOS os callers passarem pelo mesmo caminho).
 *
 * `pagamento` precisa ser o registro JA CARREGADO do banco (com
 * comanda_id/pedido_id/valor/metodo) — quem chama busca antes de confirmar.
 * `origem` e so para o audit log (ex: 'webhook_point', 'poll_mercadopago').
 */
async function confirmarPagamento(repos, empresaId, pagamento, novoStatus, origem) {
  const { pagamentoRepo, comandaRepo, pedidoRepo, transacaoRepo, clienteRepo, caixaRepo, auditoriaRepo } = repos
  if (pagamento.status === novoStatus) return // ja processado (idempotencia)

  await pagamentoRepo.update(empresaId, pagamento.id, { status: novoStatus, updated_at: new Date() })

  if (pagamento.comanda_id) {
    await comandaRepo.atualizarStatusPagamentoResumo(empresaId, pagamento.comanda_id, pagamento.id, novoStatus)
    // `atualizarStatusPagamentoResumo` so atualiza o STATUS do item dentro do
    // array `pagamentos`. `pago`/`restante`/`total`, porem, sao campos
    // DERIVADOS e CACHEADOS no proprio documento/linha da comanda — em
    // ambos os backends (Mongo e Supabase: ver `setDerivados()` em cada
    // repo), recalculados e persistidos apenas por `reloadComanda()` em
    // route.js, que so roda dentro dos handlers HTTP de comanda. Sem este
    // passo aqui, um GET /comandas/:id logo apos o webhook confirmar
    // continuaria mostrando o `restante` antigo ate a proxima mutacao da
    // comanda por outro caminho (add item, transferir, etc.) — o que
    // quebraria a propria verificacao manual desta task (Step 5) e a
    // promessa desta funcao ("sincroniza a comanda"). Achado durante o
    // teste manual, nao previsto no texto original do brief.
    const comandaAtualizada = await comandaRepo.findById(empresaId, pagamento.comanda_id)
    if (comandaAtualizada) await comandaRepo.setDerivados(empresaId, pagamento.comanda_id, computeComanda(comandaAtualizada))
  }

  if (pagamento.pedido_id && novoStatus === 'approved') {
    const pedido = await pedidoRepo.findById(empresaId, pagamento.pedido_id)
    // `pago_em` ja preenchido: outra notificacao (webhook + poll na mesma
    // janela) chegou primeiro. Nunca lancar receita duas vezes.
    if (pedido && !pedido.pago_em) {
      const pagoEm = new Date()
      await pedidoRepo.update(empresaId, pedido.id, { pago_em: pagoEm })
      const caixaAberto = await caixaRepo.findAberto(empresaId)
      const custoMapa = await mapaCustoProdutos(repos, { empresa_id: empresaId }, pedido.itens)
      const custo = computeCustoVenda({ itens: pedido.itens, custoPorProduto: custoMapa })
      await transacaoRepo.create({
        id: uuidv4(), empresa_id: empresaId, tipo: 'receita', categoria: 'Vendas',
        descricao: `Pedido #${pedido.numero}`, valor: pagamento.valor, pedido_id: pedido.id,
        forma_pagamento: pagamento.metodo, caixa_id: caixaAberto ? caixaAberto.id : null,
        custo_total: custo.custo_total, receita_com_custo: custo.receita_com_custo, receita_base: custo.receita_base,
        data: pagoEm, created_at: pagoEm,
      })
      if (pedido.cliente_id) await clienteRepo.incrementarMetricasPedido(empresaId, pedido.cliente_id, pagamento.valor)
    }
  }

  await auditoriaRepo.registrar({
    empresa_id: empresaId, usuario_id: null, usuario_nome: `Mercado Pago (${origem})`,
    acao: 'pagamento_confirmado', entidade: 'pagamento', entidade_id: pagamento.id,
    dados: { status: novoStatus, comanda_id: pagamento.comanda_id, pedido_id: pagamento.pedido_id },
  })
}

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
        tipo: ['para_levar', 'delivery'][Math.floor(Math.random() * 2)],
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
    { id: uuidv4(), produto_id: prods[5].id, nome: prods[5].nome, preco: prods[5].preco, quantidade: 2, observacao: 'Sem cebola', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
    { id: uuidv4(), produto_id: prods[6].id, nome: prods[6].nome, preco: prods[6].preco, quantidade: 2, observacao: '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
    { id: uuidv4(), produto_id: prods[8].id, nome: prods[8].nome, preco: prods[8].preco, quantidade: 1, observacao: '', operador_id: ctx.usuario_id, operador_nome: ctx.nome, created_at: new Date() },
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
  // Preenchido assim que `ctx` existe (logo apos autenticar), pra o catch-all
  // no fim da funcao poder marcar o erro com `empresa_id` mesmo sem ter
  // acesso direto a `ctx` (que e local ao bloco onde foi declarado). Fica
  // `null` para erro que aconteceu ANTES de autenticar (ex: JSON invalido em
  // /auth/login) — o relato ainda sai, so sem esse campo.
  let ctxParaErro = null

  try {
    const repos = await getRepositories()
    const {
      categoriaRepo, produtoRepo, clienteRepo, usuarioRepo, transacaoRepo,
      auditoriaRepo, integracaoRepo, mesaRepo, conversaRepo, mensagemRepo,
      pedidoRepo, comandaRepo, pagamentoRepo, empresaRepo, webhookEventsRepo,
      kdsTokenRepo, entregadorRepo, caixaRepo, caixaMovimentoRepo, contaRepo,
      assinaturaRepo, assinaturaPagamentoRepo, plataformaAdminRepo,
    } = repos

    /* -------- health / meta -------- */
    if (route === '/' || route === '/health') {
      // Reporta configuracao FALTANTE, nao os valores (nunca vazar segredo).
      // Existe porque um deploy sem JWT_SECRET subia "ok" e so quebrava no
      // primeiro login bem-sucedido — falha tardia e confusa de diagnosticar.
      // Aqui ela fica visivel no primeiro healthcheck.
      const faltando = []
      if (!process.env.JWT_SECRET) faltando.push('JWT_SECRET')
      if (getProviderName() === 'supabase' && !isSupabaseConfigured()) {
        faltando.push('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY')
      }
      if (getProviderName() === 'mongo' && !(process.env.MONGO_URL && process.env.DB_NAME)) {
        faltando.push('MONGO_URL/DB_NAME')
      }
      const degradado = faltando.length > 0 && process.env.NODE_ENV === 'production'
      return json({
        service: 'restaurant-os',
        status: degradado ? 'degraded' : 'ok',
        // `database` e o backend REALMENTE em uso nesta requisicao; o bloco
        // `providers.supabase` continua indicando apenas se ha credenciais
        // configuradas (que nao implica que o Supabase seja o runtime ativo).
        database: getProviderName(),
        ...(faltando.length ? { config_faltando: faltando } : {}),
        providers: { supabase: supabaseProviderStatus() },
      }, degradado ? 503 : 200)
    }

    /* ==================== AUTH ==================== */
    if (route === '/auth/register' && method === 'POST') {
      // 5 cadastros por hora por IP: sem isso, um script cria tenant sem
      // limite (cada um com seed proprio — 71+ empresas de teste ja
      // poluiram producao uma vez por esse motivo exato, ver C1 no
      // HANDOFF). So por IP, nao por e-mail: cada tentativa de abuso usa
      // e-mail novo, entao um limite por e-mail nao freia nada.
      //
      // `ipRegistro === null` (sem X-Forwarded-For/X-Real-IP) so acontece
      // sem proxy na frente — nunca em producao, atras do Traefik do
      // EasyPanel. Pular o limite ali e correto: nao ha "um cliente" pra
      // identificar, e e exatamente o cenario da propria suite de testes
      // (centenas de registros em sequencia direto no servidor local).
      const ipRegistro = ipDoCliente(request)
      if (ipRegistro) {
        const limiteRegistro = checarLimite(`register:${ipRegistro}`, 5, 60 * 60 * 1000)
        if (!limiteRegistro.permitido) {
          return err('Muitas tentativas de cadastro. Tente novamente em alguns minutos.', 429)
        }
      }
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
          // Ligado = o que o produto entrega hoje. Ate 2026-08-18 esta linha
          // gravava `estoque: false` e `caixa: false` em empresas que usavam
          // os dois modulos normalmente — as flags nasciam erradas porque
          // ninguem as lia. Agora que o portao e real, o default mente caro.
          feature_flags: flagsPadraoSignup(),
          // Padrao claro (pedido do dono, 2026-08-18: "quero que o site abra
          // na cor branca"). O dono continua podendo trocar por empresa —
          // isto e so o valor com que uma empresa NOVA nasce.
          appearance: { cor_principal: '#4f46e5', cor_secundaria: '#7c3aed', tema: 'light', nome_exibido: empresa_nome },
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

      // Ate 2026-08-19 rodava `seedEmpresa()` aqui, sempre — toda empresa
      // nova ja nascia com dados ficticios, o que esvaziava o checklist de
      // onboarding (B2): "cadastrar categoria"/"criar mesas" apareceriam
      // prontos sem o dono ter feito nada. Virou `POST /empresa/seed-demo`,
      // sob demanda, oferecido como "quero ver com dados de exemplo".
      const ctx = { empresa_id, usuario_id, nome, papel: 'OWNER' }
      await audit(repos, ctx, 'register', 'empresa', empresa_id, { empresa_nome })

      const token = signToken({ usuario_id, empresa_id, papel: 'OWNER' })
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS.OWNER })
    }

    if (route === '/auth/login' && method === 'POST') {
      const { email, senha } = (await request.json()) || {}
      if (!email || !senha) return err('E-mail e senha obrigatorios')
      const emailParaLimite = String(email).toLowerCase().trim()
      // 10 tentativas por 15min por (IP, email) — nao so por IP: um IP
      // compartilhado (escritorio, NAT) nao pode travar todo mundo por causa
      // de um so usuario errando a senha. Nao so por email tambem: sem o IP,
      // um atacante rotacionando de maquina continuaria livre, mas o alvo
      // real aqui e o script simples martelando uma conta conhecida — a
      // combinacao cobre esse caso sem punir vizinho de rede. Ver
      // `ipDoCliente()` para por que `null` (sem proxy na frente) pula o
      // limite em vez de compartilhar um balde entre todo mundo sem header.
      const ipLogin = ipDoCliente(request)
      if (ipLogin) {
        const limiteLogin = checarLimite(`login:${ipLogin}:${emailParaLimite}`, 10, 15 * 60 * 1000)
        if (!limiteLogin.permitido) {
          return err('Muitas tentativas. Tente novamente em alguns minutos.', 429)
        }
      }
      const usuario = await usuarioRepo.findByEmail(emailParaLimite)
      if (!usuario || !verifyPassword(senha, usuario.senha_hash)) return err('Credenciais invalidas', 401)
      if (!usuario.ativo) return err('Usuario inativo', 403)
      const empresa = await empresaRepo.findById(usuario.empresa_id)
      // Bloqueio TOTAL do Painel da Plataforma (`empresas.ativo`) — sem essa
      // checagem aqui, desligar uma empresa no painel nao teria efeito
      // nenhum: o login continuaria emitindo token normalmente.
      if (!empresa?.ativo) return err('Acesso suspenso. Fale com a ETNA para regularizar.', 403)
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
      const pagamento = await pagamentoRepo.findByProviderPaymentId(empresaId, 'mercadopago', String(dataId))
      if (!pagamento) return json({ ok: true }) // pagamento de outro fluxo, nunca aconteceu por aqui
      await confirmarPagamento(repos, empresaId, pagamento, statusInfo.status, 'webhook_pix')
      return json({ ok: true, status: statusInfo.status })
    }

    /* ==================== WEBHOOK WHATSAPP (Evolution, pre-auth, assinado) ====================
     * Mesmo padrao do webhook do Mercado Pago (:603): valida o segredo antes
     * de tocar em qualquer dado, e deduplica por evento. Sem isso, qualquer
     * um que descubra um empresa_id (vaza em URL/print/ticket) injeta
     * cliente+conversa+mensagem falsos na caixa de atendimento de outra
     * empresa — o dado mais sensivel deste endpoint nao e o que ele le, e o
     * que ele grava.
     */
    if (route === '/whatsapp/webhook' && method === 'POST') {
      const url = new URL(request.url)
      const empresaId = url.searchParams.get('tenant')
      const secret = url.searchParams.get('secret')
      if (!empresaId) return json({ ok: true, ignored: 'no-tenant' })
      const integ = await integracaoRepo.findByTipo(empresaId, 'evolution')
      const expectedSecret = integ?.config?.webhookSecret
      if (!integ || integ.status !== 'configurado' || !expectedSecret) {
        return json({ ok: true, ignored: 'not-configured' })
      }
      const validSecret = Boolean(secret) && secret.length === expectedSecret.length &&
        crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))
      if (!validSecret) return json({ error: 'assinatura invalida' }, 401)

      const body = (await request.json().catch(() => ({}))) || {}
      const data = body.data || body
      const key = data.key || {}
      if (key.fromMe) return json({ ok: true, ignored: 'from_me' }) // apenas inbound
      const remoteJid = key.remoteJid || data.remoteJid || ''
      const numero = String(remoteJid).split('@')[0].replace(/\D/g, '')
      if (!numero) return json({ ok: true, ignored: 'no-number' })

      // Idempotencia: mesma mensagem reentregue pela Evolution (retry de
      // rede) nao duplica cliente/conversa/mensagem. Sem messageId (payload
      // atipico), segue sem dedupe em vez de arriscar descartar mensagem
      // real por falta de chave.
      if (key.id) {
        const dedupe = await webhookEventsRepo.upsert(empresaId, `${empresaId}:${key.id}`, 'evolution')
        if (!dedupe.isNew) return json({ ok: true, duplicated: true })
      }

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

    /* ==================== KDS (leitura/acao publica via token OU JWT) ====================
     * Fica ANTES do portao de autenticacao padrao de proposito: a TV nao
     * loga como usuario (docs/plans/KDS-DESIGN.md §5.4). resolveKdsAuth()
     * aceita Bearer JWT normal (celular do atendente, ou COZINHA pelo
     * navegador) OU ?tv_token=... (TV, sem login).
     */
    const resolveKdsAuth = async () => {
      const url = new URL(request.url)
      const tvToken = url.searchParams.get('tv_token')
      if (tvToken) {
        const rec = await kdsTokenRepo.findByToken(tvToken)
        if (!rec || rec.revogado_em) return null
        return { empresa_id: rec.empresa_id, modo: rec.modo, isTv: true, usuario_id: null, nome: 'TV Cozinha' }
      }
      const session = await auth(request)
      if (!session) return null
      const usuario = await usuarioRepo.findById(session.empresa_id, session.usuario_id)
      if (!usuario || !usuario.ativo) return null
      return { empresa_id: session.empresa_id, usuario_id: usuario.id, papel: usuario.papel, nome: usuario.nome, isTv: false }
    }

    if (route === '/kds/pendentes' && method === 'GET') {
      const kctx = await resolveKdsAuth()
      if (!kctx) return err('Nao autorizado', 401)
      if (!kctx.isTv && !can(kctx.papel, 'pedidos')) return err('Sem permissao', 403)

      const [pedidos, comandas] = await Promise.all([
        pedidoRepo.list(kctx.empresa_id),
        comandaRepo.list(kctx.empresa_id, { status: 'aberta' }),
      ])
      const pedidosPendentes = pedidos
        .filter((p) => ['novo', 'em_preparacao'].includes(normPedidoStatus(p.status)))
        .map((p) => ({
          origem: 'pedido', id: p.id, numero: p.numero, tipo: p.tipo,
          itens: (p.itens || []).map((it) => ({ nome: it.nome, quantidade: it.quantidade, observacao: it.observacao || '' })),
          created_at: p.created_at,
        }))
      const itensMesaPendentes = comandas.flatMap((c) => (c.itens || [])
        .filter((it) => !it.entregue)
        .map((it) => ({
          origem: 'mesa', id: it.id, comanda_id: c.id, mesa_nome: c.mesa_nome,
          nome: it.nome, quantidade: it.quantidade, observacao: it.observacao || '',
          created_at: it.created_at,
        })))
      const itens = [...pedidosPendentes, ...itensMesaPendentes]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      return json({ itens, modo: kctx.isTv ? kctx.modo : null })
    }

    if (route === '/kds/concluir' && method === 'POST') {
      const kctx = await resolveKdsAuth()
      if (!kctx) return err('Nao autorizado', 401)
      const b = (await request.json()) || {}
      if (!['pedido', 'mesa'].includes(b.origem) || !b.id) return err('Campos obrigatorios: origem, id')
      if (b.origem === 'mesa' && !b.comanda_id) return err('Campo obrigatorio: comanda_id')

      if (kctx.isTv) {
        if (kctx.modo !== 'toque') return err('Este link e somente leitura', 403)
      } else {
        const permNecessaria = b.origem === 'pedido' ? 'pedidos' : 'mesas'
        if (!can(kctx.papel, permNecessaria)) return err('Sem permissao', 403)
      }

      if (b.origem === 'pedido') {
        const pedido = await pedidoRepo.findById(kctx.empresa_id, b.id)
        if (!pedido) return err('Pedido nao encontrado', 404)
        const updated = await pedidoRepo.update(kctx.empresa_id, b.id, { status: 'pronto', updated_at: new Date() })
        if (!updated) return err('Falha ao atualizar pedido', 500)
      } else {
        const updated = await comandaRepo.updateItemCampos(kctx.empresa_id, b.comanda_id, b.id, { entregue: true })
        if (!updated) return err('Falha ao atualizar item', 500)
      }
      await audit(repos, { empresa_id: kctx.empresa_id, usuario_id: kctx.usuario_id, nome: kctx.nome }, 'concluir', b.origem === 'pedido' ? 'pedido' : 'comanda_item', b.id, {})
      return json({ ok: true })
    }

    /* ==================== CARDAPIO DIGITAL (visualizacao publica, sem login) ==================== */

    if (seg[0] === 'cardapio' && seg[1] && method === 'GET') {
      const empresa = await empresaRepo.findBySlug(seg[1])
      if (!empresa || !empresa.ativo) return err('Cardapio nao encontrado', 404)

      const [categorias, produtos] = await Promise.all([
        categoriaRepo.list(empresa.id),
        produtoRepo.list(empresa.id),
      ])

      const categoriasVisiveis = categorias
        .filter((c) => c.ativo)
        .sort((a, b) => a.ordem - b.ordem)
        .map((c) => ({ id: c.id, nome: c.nome }))

      const produtosVisiveis = produtos
        .filter((p) => p.ativo && p.disponivel)
        .map((p) => ({
          id: p.id,
          categoria_id: p.categoria_id,
          nome: p.nome,
          descricao: p.descricao,
          preco: p.preco,
          imagem: p.imagem,
        }))

      // Indisponiveis hoje: mesmo campo `disponivel` do toggle "Em Falta" ja
      // existente (nao e campo novo). So nomes — o cliente na mesa nao
      // precisa de mais que isso para saber o que nao pedir.
      const indisponiveisHoje = produtos
        .filter((p) => p.ativo && !p.disponivel)
        .map((p) => p.nome)

      return json({
        empresa: {
          nome: empresa.nome_comercial || empresa.nome,
          logo: empresa.logo,
          cor_principal: empresa.config?.appearance?.cor_principal || null,
          cardapio_imagem_url: empresa.cardapio_imagem_url || null,
        },
        categorias: categoriasVisiveis,
        produtos: produtosVisiveis,
        indisponiveis_hoje: indisponiveisHoje,
      })
    }

    /* ---- a partir daqui, tudo autenticado ---- */
    const session = await auth(request)
    if (!session) return err('Nao autorizado', 401)
    // usuario + empresa em paralelo: o Painel da Plataforma pode bloquear
    // (`empresas.ativo`) a qualquer momento, e o token dura ate 7 dias
    // (TOKEN_TTL_SEC) — sem checar aqui, um bloqueio so surtiria efeito no
    // PROXIMO login, nao imediatamente. `usuario.ativo` ja pagava esta
    // consulta a cada requisicao; buscar a empresa junto (Promise.all) nao
    // serializa uma segunda viagem ao banco.
    const [usuario, empresaSessao] = await Promise.all([
      usuarioRepo.findById(session.empresa_id, session.usuario_id),
      empresaRepo.findById(session.empresa_id),
    ])
    if (!usuario || !usuario.ativo) return err('Sessao invalida', 401)
    if (!empresaSessao?.ativo) return err('Acesso suspenso. Fale com a ETNA para regularizar.', 403)
    const ctx = { empresa_id: session.empresa_id, usuario_id: session.usuario_id, nome: usuario.nome, papel: usuario.papel, email: usuario.email }
    const tenant = { empresa_id: ctx.empresa_id } // escopo multitenant obrigatorio
    ctxParaErro = ctx

    /**
     * Portao de PLANO (feature flags), independente do portao de PAPEL (`can`).
     * As duas checagens sao ortogonais: `can` pergunta "este usuario pode?",
     * `exigeModulo` pergunta "esta empresa contratou?". Um GERENTE tem
     * permissao de caixa, mas nao abre caixa numa empresa sem o modulo.
     *
     * A empresa e carregada sob demanda e memoizada nesta requisicao: a
     * maioria das rotas nao precisa dela, e cobrar uma consulta a mais de
     * TODAS elas para atender um punhado seria pagar caro pelo gate. O cache
     * vive no escopo do handler, entao nao vaza entre requisicoes.
     */
    let _empresaCache = empresaSessao // ja buscada acima para checar `ativo` — nao refazer a consulta
    const empresaAtual = async () => {
      if (_empresaCache === undefined) _empresaCache = await empresaRepo.findById(ctx.empresa_id)
      return _empresaCache
    }
    /** Devolve uma resposta 403 se o modulo estiver desligado, ou null se pode seguir. */
    const exigeModulo = async (modulo) => {
      if (temModulo(await empresaAtual(), modulo)) return null
      const label = MODULOS[modulo]?.label || modulo
      // 403 e nao 404: esconder a existencia do modulo faria o dono achar que
      // e bug. A mensagem precisa dizer o que fazer, nao so que negou.
      return err(`Modulo "${label}" desativado para esta empresa. Ative em Empresa > Modulos.`, 403)
    }

    if (route === '/auth/me' && method === 'GET') {
      const empresa = await empresaRepo.findById(ctx.empresa_id)
      // `modulos` vem resolvido do servidor em vez de o front reinterpretar
      // `config.feature_flags` por conta propria: uma segunda implementacao da
      // regra de default e uma segunda chance de divergir do portao real.
      return json({
        usuario: clean(usuario),
        empresa: clean(empresa),
        permissions: PERMISSIONS[usuario.papel] || [],
        roles: ROLES,
        modulos: modulosAtivos(empresa),
      })
    }

    /* ==================== MODULOS ==================== */
    // Catalogo para a tela de configuracoes: so o que da para ligar/desligar
    // hoje, com o estado atual.
    //
    // Nao devolve a lista de modulos "em breve": a tela deixou de exibi-los a
    // pedido do dono ("pode retirar o que nao estamos usando"), e uma vitrine
    // de promessas nao ajuda quem so quer conferir o que contratou. As flags
    // deles CONTINUAM sendo gravadas como `false` no signup — ver
    // flagsPadraoSignup(): flag ausente conta como ligada, entao apagar o
    // registro abriria sozinho um modulo futuro no dia em que ele ganhasse
    // portao.
    if (route === '/modulos' && method === 'GET') {
      const empresa = await empresaAtual()
      return json({
        disponiveis: Object.entries(MODULOS).map(([chave, m]) => ({
          chave, label: m.label, descricao: m.descricao, ativo: temModulo(empresa, chave),
        })),
      })
    }

    /**
     * PUT /modulos/:chave { ativo: bool } — liga/desliga um modulo.
     *
     * Endpoint proprio em vez de PUT /empresa com o config cru: so aqui o
     * mapa modulo -> flags do registro e aplicado, entao "Mesas & Comandas"
     * escreve `mesas` E `comandas` sem o front precisar saber disso. Cliente
     * que escreve config na mao volta a poder criar o estado incoerente que
     * este trabalho veio eliminar.
     *
     * Enquanto nao existe billing (B3), quem decide e o dono. Quando o plano
     * passar a mandar, LIGAR vira decisao do plano e este handler passa a
     * recusar o que o plano nao cobre — desligar continua sendo do dono.
     */
    if (seg[0] === 'modulos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const chave = seg[1]
      const mod = MODULOS[chave]
      if (!mod) return err(`Modulo "${chave}" nao pode ser configurado`, 404)
      const b = (await request.json()) || {}
      if (typeof b.ativo !== 'boolean') return err('ativo deve ser true ou false')

      const empresa = await empresaRepo.findById(ctx.empresa_id)
      const config = { ...(empresa?.config || {}) }
      const flags = { ...(config.feature_flags || {}) }
      for (const f of mod.flags) flags[f] = b.ativo
      config.feature_flags = flags
      await empresaRepo.update(ctx.empresa_id, { config })
      _empresaCache = undefined // a empresa mudou nesta requisicao; nao servir o estado velho
      await audit(repos, ctx, b.ativo ? 'ativar_modulo' : 'desativar_modulo', 'empresa', ctx.empresa_id, { modulo: chave })
      return json({ chave, label: mod.label, ativo: b.ativo })
    }

    /**
     * Onboarding guiado (B2). Cada item e DERIVADO de dados reais que ja
     * existem — nunca uma flag "concluido" gravada em algum lugar, mesma
     * regra de "nunca guardar o que da pra recalcular" do resto do sistema
     * (status_efetivo de contas/assinaturas). `destino` e a `view` do
     * frontend (ver NAV em app/page.js) pra onde o botao "Ir" de cada item
     * deve levar — o vocabulario de onde cada acao acontece mora aqui, nao
     * duplicado no cliente.
     */
    if (route === '/onboarding/status' && method === 'GET') {
      const empresa = await empresaAtual()
      const [categorias, produtos, mesas, transacoes] = await Promise.all([
        categoriaRepo.list(ctx.empresa_id),
        produtoRepo.list(ctx.empresa_id),
        temModulo(empresa, 'mesas') ? mesaRepo.list(ctx.empresa_id) : Promise.resolve([]),
        transacaoRepo.list(ctx.empresa_id),
      ])
      const itens = [
        { chave: 'categoria', label: 'Cadastre sua primeira categoria', destino: 'cardapio', feito: categorias.length > 0 },
        { chave: 'produto_custo', label: 'Cadastre um produto com o custo preenchido', destino: 'cardapio', feito: produtos.some((p) => p.custo !== null && p.custo !== undefined) },
        { chave: 'venda', label: 'Registre sua primeira venda', destino: 'pedidos', feito: transacoes.some((t) => t.tipo === 'receita') },
      ]
      if (temModulo(empresa, 'mesas')) {
        itens.splice(2, 0, { chave: 'mesa', label: 'Configure suas mesas', destino: 'mesas', feito: mesas.length > 0 })
      }
      return json({ itens, completo: itens.every((i) => i.feito) })
    }

    /**
     * Popula a empresa com dados de demonstracao (produtos, mesas, pedidos
     * de exemplo etc.) — SOB DEMANDA, nunca mais automatico no signup (ate
     * 2026-08-19 rodava sozinho em TODO cadastro, o que esvaziava o
     * proposito do checklist de onboarding acima: toda empresa nova ja
     * "nascia pronta"). Bloqueado se a empresa ja tem alguma categoria — nao
     * ha como semear duas vezes sem duplicar tudo.
     */
    if (route === '/empresa/seed-demo' && method === 'POST') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const categorias = await categoriaRepo.list(ctx.empresa_id)
      if (categorias.length > 0) return err('Esta empresa ja tem dados cadastrados', 409)
      await seedEmpresa(repos, ctx.empresa_id, ctx)
      return json({ ok: true })
    }

    /* ==================== ASSINATURA (visao do CLIENTE) ====================
     * O restaurante consultando o proprio contrato com a ETNA. So leitura —
     * mudar valor/vencimento/status e sempre acao do Painel da Plataforma
     * (abaixo), nunca do proprio cliente.
     */
    if (route === '/assinatura/status' && method === 'GET') {
      const assinatura = await assinaturaRepo.findByEmpresa(ctx.empresa_id)
      // Empresa sem assinatura cadastrada (ainda nao aconteceu pra nenhuma
      // em producao, mas o endpoint nao pode quebrar por isso): nada a
      // avisar, silencio e a resposta correta.
      if (!assinatura) return json({ aviso: null })
      return json({ aviso: avisoParaCliente(assinatura) })
    }

    /* ==================== PLATAFORMA (admin da ETNA, nao de um restaurante) ====================
     * Identidade por E-MAIL (`plataforma_admins`, migration 0027) — nunca por
     * papel nem empresa_id. Um usuario comum de qualquer empresa cujo e-mail
     * bata com a tabela vira admin da plataforma; ninguem mais chega perto
     * destas rotas. Reconferido a cada requisicao (mesma disciplina do
     * `papel`, que tambem nunca vem do token).
     */
    const souPlataformaAdmin = async () => Boolean(ctx.email && await plataformaAdminRepo.findByEmail(ctx.email))
    const exigePlataformaAdmin = async () => (await souPlataformaAdmin()) ? null : err('Sem permissao', 403)

    if (route === '/plataforma/eu' && method === 'GET') {
      return json({ admin: await souPlataformaAdmin() })
    }

    if (route === '/plataforma/empresas' && method === 'GET') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const [empresas, assinaturas, logins] = await Promise.all([
        empresaRepo.list(),
        assinaturaRepo.listTodas(),
        auditoriaRepo.listLogins(),
      ])
      const assinaturaPorEmpresa = new Map(assinaturas.map((a) => [a.empresa_id, a]))
      // `logins` ja vem ordenado por data desc (ver repository) — o PRIMEIRO
      // que aparece pra cada empresa_id e o mais recente. Reduzido aqui em
      // vez de GROUP BY no banco, de proposito (ver nota no repository).
      const ultimoLoginPorEmpresa = new Map()
      for (const l of logins) if (!ultimoLoginPorEmpresa.has(l.empresa_id)) ultimoLoginPorEmpresa.set(l.empresa_id, l.created_at)

      const linhas = empresas.map((e) => {
        const assinatura = assinaturaPorEmpresa.get(e.id) || null
        return {
          empresa_id: e.id,
          nome: e.nome_comercial || e.nome,
          slug: e.slug,
          ativo: e.ativo,
          created_at: e.created_at,
          ultimo_acesso: ultimoLoginPorEmpresa.get(e.id) || null,
          assinatura: assinatura ? { ...clean(assinatura), status_efetivo: statusEfetivoAssinatura(assinatura) } : null,
        }
      })
      const comStatus = linhas.filter((l) => l.assinatura).map((l) => l.assinatura)
      return json({ empresas: linhas, resumo: resumoCarteira(comStatus) })
    }

    /**
     * Cria OU atualiza a assinatura de uma empresa. Endpoint so de
     * configuracao — nunca avanca vencimento nem gera pagamento (isso e
     * `/plataforma/assinaturas/:id/pagar`, abaixo). `empresa_id` UNIQUE na
     * tabela (migration 0027): upsert por empresa, nunca duplicata.
     */
    if (seg[0] === 'plataforma' && seg[1] === 'empresas' && seg[2] && seg[3] === 'assinatura' && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const empresaId = seg[2]
      const empresaAlvo = await empresaRepo.findById(empresaId)
      if (!empresaAlvo) return err('Empresa nao encontrada', 404)
      const b = (await request.json()) || {}
      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor < 0) return err('valor deve ser um numero valido')
      const diaVencimento = Number(b.dia_vencimento)
      if (!Number.isInteger(diaVencimento) || diaVencimento < 1 || diaVencimento > 31) return err('dia_vencimento deve ser um inteiro entre 1 e 31')
      if (!b.proximo_vencimento) return err('proximo_vencimento obrigatorio')

      const existente = await assinaturaRepo.findByEmpresa(empresaId)
      let salva
      if (existente) {
        salva = await assinaturaRepo.update(existente.id, {
          plano: b.plano || existente.plano, valor: round2(valor), dia_vencimento: diaVencimento,
          proximo_vencimento: b.proximo_vencimento, status: 'ativa', observacoes: b.observacoes ?? existente.observacoes,
          updated_at: new Date(),
        })
      } else {
        salva = await assinaturaRepo.create({
          id: uuidv4(), empresa_id: empresaId, plano: b.plano || 'basico', valor: round2(valor),
          dia_vencimento: diaVencimento, proximo_vencimento: b.proximo_vencimento, status: 'ativa',
          ultimo_pagamento_em: null, observacoes: b.observacoes || '', created_at: new Date(), updated_at: new Date(),
        })
      }
      await auditoriaRepo.registrar({ empresa_id: empresaId, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: 'configurar_assinatura', entidade: 'assinatura', entidade_id: salva.id, dados: { plano: salva.plano, valor: salva.valor } })
      return json(clean({ ...salva, status_efetivo: statusEfetivoAssinatura(salva) }))
    }

    /**
     * Registra 1 mensalidade paga e AVANCA `proximo_vencimento` em 1 mes —
     * `adicionarMeses()` (lib/contas.js, ja usado pra recorrencia de contas)
     * clampa no ultimo dia do mes destino, entao "todo dia 31" nunca rola
     * pra marco em fevereiro. O historico (`assinatura_pagamentos`) nunca e
     * sobrescrito — e a memoria de quem sempre paga atrasado.
     */
    if (seg[0] === 'plataforma' && seg[1] === 'assinaturas' && seg[2] && seg[3] === 'pagar' && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const assinatura = await assinaturaRepo.findById(seg[2])
      if (!assinatura) return err('Assinatura nao encontrada', 404)
      const b = (await request.json()) || {}
      const pagoEm = b.pago_em || new Date().toISOString().slice(0, 10)
      const valorPago = Number(b.valor) || assinatura.valor

      const pagamento = await assinaturaPagamentoRepo.create({
        id: uuidv4(), empresa_id: assinatura.empresa_id, assinatura_id: assinatura.id,
        valor: round2(valorPago), competencia: assinatura.proximo_vencimento, pago_em: pagoEm,
        metodo: b.metodo || '', observacoes: b.observacoes || '', registrado_por: ctx.nome || '',
        created_at: new Date(),
      })
      const novoVencimento = adicionarMeses(assinatura.proximo_vencimento, 1)
      const atualizada = await assinaturaRepo.update(assinatura.id, {
        proximo_vencimento: novoVencimento, ultimo_pagamento_em: pagoEm, updated_at: new Date(),
      })
      await auditoriaRepo.registrar({ empresa_id: assinatura.empresa_id, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: 'registrar_pagamento_assinatura', entidade: 'assinatura', entidade_id: assinatura.id, dados: { valor: pagamento.valor, novo_vencimento: novoVencimento } })
      return json({ assinatura: clean({ ...atualizada, status_efetivo: statusEfetivoAssinatura(atualizada) }), pagamento: clean(pagamento) })
    }

    if (seg[0] === 'plataforma' && seg[1] === 'assinaturas' && seg[2] && seg[3] === 'cancelar' && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const assinatura = await assinaturaRepo.findById(seg[2])
      if (!assinatura) return err('Assinatura nao encontrada', 404)
      const atualizada = await assinaturaRepo.update(assinatura.id, { status: 'cancelada', updated_at: new Date() })
      await auditoriaRepo.registrar({ empresa_id: assinatura.empresa_id, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: 'cancelar_assinatura', entidade: 'assinatura', entidade_id: assinatura.id, dados: {} })
      return json(clean({ ...atualizada, status_efetivo: statusEfetivoAssinatura(atualizada) }))
    }

    /**
     * Pausa o AVISO ao cliente (cortesia) sem tocar no vencimento real —
     * decisao explicita do dono (2026-08-19): "preciso ter a possibilidade
     * de pausar o aviso... caso eu queira dar um mes de cortesia". A
     * assinatura continua "atrasada" de verdade no Painel da Plataforma
     * (entra em "valor em atraso"); so o que o CLIENTE ve fica escondido
     * ate `ate` (`avisoPausado()` em lib/assinatura.js). `ate: null`
     * cancela uma pausa em andamento antes do prazo.
     */
    if (seg[0] === 'plataforma' && seg[1] === 'assinaturas' && seg[2] && seg[3] === 'pausar-aviso' && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const assinatura = await assinaturaRepo.findById(seg[2])
      if (!assinatura) return err('Assinatura nao encontrada', 404)
      const b = (await request.json()) || {}
      if (b.ate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(b.ate || '')) return err('ate deve ser "YYYY-MM-DD" ou null')
      const atualizada = await assinaturaRepo.update(assinatura.id, { aviso_pausado_ate: b.ate, updated_at: new Date() })
      await auditoriaRepo.registrar({ empresa_id: assinatura.empresa_id, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: b.ate ? 'pausar_aviso_assinatura' : 'retomar_aviso_assinatura', entidade: 'assinatura', entidade_id: assinatura.id, dados: { ate: b.ate } })
      return json(clean({ ...atualizada, status_efetivo: statusEfetivoAssinatura(atualizada) }))
    }

    /**
     * Bloqueio TOTAL de acesso — `empresas.ativo`, o mesmo campo que ja
     * existia (agora de fato aplicado no login, ver auth/login abaixo).
     * SEMPRE manual: nada neste sistema desliga uma empresa sozinho so
     * porque a mensalidade atrasou — decisao explicita do dono
     * (2026-08-18): "eu devo ter a opcao de bloquear".
     */
    if (seg[0] === 'plataforma' && seg[1] === 'empresas' && seg[2] && seg[3] === 'bloqueio' && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const empresaId = seg[2]
      const empresaAlvo = await empresaRepo.findById(empresaId)
      if (!empresaAlvo) return err('Empresa nao encontrada', 404)
      const b = (await request.json()) || {}
      if (typeof b.ativo !== 'boolean') return err('ativo deve ser true ou false')
      await empresaRepo.update(empresaId, { ativo: b.ativo })
      await auditoriaRepo.registrar({ empresa_id: empresaId, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: b.ativo ? 'desbloquear_empresa' : 'bloquear_empresa', entidade: 'empresa', entidade_id: empresaId, dados: {} })
      return json({ empresa_id: empresaId, ativo: b.ativo })
    }

    /**
     * Bloqueio PARCIAL — desliga um modulo especifico de uma empresa
     * qualquer. Mesma logica de PUT /modulos/:chave (que so o OWNER da
     * PROPRIA empresa pode chamar); esta variante e o equivalente pra
     * quando quem decide e o admin da plataforma, mirando qualquer empresa.
     */
    if (seg[0] === 'plataforma' && seg[1] === 'empresas' && seg[2] && seg[3] === 'modulos' && seg[4] && method === 'PUT') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const empresaId = seg[2]
      const chave = seg[4]
      const mod = MODULOS[chave]
      if (!mod) return err(`Modulo "${chave}" nao pode ser configurado`, 404)
      const empresaAlvo = await empresaRepo.findById(empresaId)
      if (!empresaAlvo) return err('Empresa nao encontrada', 404)
      const b = (await request.json()) || {}
      if (typeof b.ativo !== 'boolean') return err('ativo deve ser true ou false')

      const config = { ...(empresaAlvo.config || {}) }
      const flags = { ...(config.feature_flags || {}) }
      for (const f of mod.flags) flags[f] = b.ativo
      config.feature_flags = flags
      await empresaRepo.update(empresaId, { config })
      await auditoriaRepo.registrar({ empresa_id: empresaId, usuario_id: ctx.usuario_id, usuario_nome: ctx.nome, acao: b.ativo ? 'ativar_modulo' : 'desativar_modulo', entidade: 'empresa', entidade_id: empresaId, dados: { modulo: chave, via: 'plataforma' } })
      return json({ chave, label: mod.label, ativo: b.ativo })
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
      // merge profundo de config (appearance / pagamentos / feature_flags / delivery)
      const config = { ...(current?.config || {}) }
      if (b.config) {
        if (b.config.appearance) config.appearance = { ...(config.appearance || {}), ...b.config.appearance }
        if (b.config.pagamentos) config.pagamentos = { ...(config.pagamentos || {}), ...b.config.pagamentos }
        if (b.config.feature_flags) config.feature_flags = { ...(config.feature_flags || {}), ...b.config.feature_flags }
        if (b.config.delivery) {
          // Validar taxa_padrao >= 0
          if (b.config.delivery.taxa_padrao !== undefined && Number(b.config.delivery.taxa_padrao) < 0) {
            return err('taxa_padrao deve ser >= 0')
          }
          // Validar tempo_estimado_min > 0 ou null
          if (b.config.delivery.tempo_estimado_min !== undefined && b.config.delivery.tempo_estimado_min !== null) {
            if (Number(b.config.delivery.tempo_estimado_min) <= 0) {
              return err('tempo_estimado_min deve ser > 0 ou null')
            }
          }
          config.delivery = { ...(config.delivery || {}), ...b.config.delivery }
        }
      }
      upd.config = config
      upd.updated_at = new Date()
      const atualizada = await empresaRepo.update(ctx.empresa_id, upd)
      await audit(repos, ctx, 'update', 'empresa', ctx.empresa_id, { campos: Object.keys(upd) })
      return json(clean(atualizada))
    }

    /**
     * Upload da logo da empresa. Recebe multipart/form-data (campo `arquivo`).
     * O `empresa_id` vem SEMPRE do token — nunca do corpo — entao nao ha como
     * uma empresa gravar por cima da logo de outra.
     */
    if (route === '/empresa/logo' && method === 'POST') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      if (!isStorageConfigured()) return err('Storage nao configurado no servidor', 503)

      let arquivo
      try {
        const form = await request.formData()
        arquivo = form.get('arquivo')
      } catch {
        return err('Envie o arquivo como multipart/form-data no campo "arquivo"')
      }
      if (!arquivo || typeof arquivo.arrayBuffer !== 'function') return err('Arquivo ausente')

      try {
        const buffer = Buffer.from(await arquivo.arrayBuffer())
        const url = await uploadLogo(ctx.empresa_id, buffer, arquivo.type)
        const atualizada = await empresaRepo.update(ctx.empresa_id, { logo: url, updated_at: new Date() })
        await audit(repos, ctx, 'update', 'empresa', ctx.empresa_id, { campos: ['logo'], tamanho_bytes: buffer.length })
        return json({ logo: url, empresa: clean(atualizada) })
      } catch (e) {
        // Erros de validacao (formato/tamanho) sao do usuario, nao do servidor.
        return err(e.message, 400)
      }
    }

    if (route === '/empresa/logo' && method === 'DELETE') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      await removeLogo(ctx.empresa_id)
      const atualizada = await empresaRepo.update(ctx.empresa_id, { logo: null, updated_at: new Date() })
      await audit(repos, ctx, 'delete', 'empresa', ctx.empresa_id, { campos: ['logo'] })
      return json({ logo: null, empresa: clean(atualizada) })
    }

    /**
     * Upload da imagem do cardapio (poster do cardapio impresso, servido no
     * link/QR publico ja existente). Mesmo padrao de /empresa/logo.
     */
    if (route === '/empresa/cardapio-imagem' && method === 'POST') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      if (!isStorageConfigured()) return err('Storage nao configurado no servidor', 503)

      let arquivo
      try {
        const form = await request.formData()
        arquivo = form.get('arquivo')
      } catch {
        return err('Envie o arquivo como multipart/form-data no campo "arquivo"')
      }
      if (!arquivo || typeof arquivo.arrayBuffer !== 'function') return err('Arquivo ausente')

      try {
        const buffer = Buffer.from(await arquivo.arrayBuffer())
        const url = await uploadCardapioImagem(ctx.empresa_id, buffer, arquivo.type)
        const atualizada = await empresaRepo.update(ctx.empresa_id, { cardapio_imagem_url: url, updated_at: new Date() })
        await audit(repos, ctx, 'update', 'empresa', ctx.empresa_id, { campos: ['cardapio_imagem_url'], tamanho_bytes: buffer.length })
        return json({ cardapio_imagem_url: url, empresa: clean(atualizada) })
      } catch (e) {
        return err(e.message, 400)
      }
    }

    if (route === '/empresa/cardapio-imagem' && method === 'DELETE') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      await removeCardapioImagem(ctx.empresa_id)
      const atualizada = await empresaRepo.update(ctx.empresa_id, { cardapio_imagem_url: null, updated_at: new Date() })
      await audit(repos, ctx, 'delete', 'empresa', ctx.empresa_id, { campos: ['cardapio_imagem_url'] })
      return json({ cardapio_imagem_url: null, empresa: clean(atualizada) })
    }

    /* ==================== KDS TOKENS (gestao dos links da TV) ==================== */
    if (route === '/kds/tokens' && method === 'GET') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const tokens = await kdsTokenRepo.listByEmpresa(ctx.empresa_id)
      return json(tokens.map(clean))
    }
    if (route === '/kds/tokens' && method === 'POST') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const modo = b.modo === 'toque' ? 'toque' : 'leitura'
      const entity = { id: uuidv4(), empresa_id: ctx.empresa_id, token: uuidv4(), modo, criado_em: new Date(), revogado_em: null }
      await kdsTokenRepo.create(entity)
      await audit(repos, ctx, 'criar', 'kds_token', entity.id, { modo })
      return json(clean(entity), 201)
    }
    if (seg[0] === 'kds' && seg[1] === 'tokens' && seg[2] && method === 'DELETE') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      await kdsTokenRepo.revoke(ctx.empresa_id, seg[2])
      await audit(repos, ctx, 'revogar', 'kds_token', seg[2], {})
      return json({ ok: true })
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
    /**
     * GET /produtos/estoque-baixo — produtos no minimo ou abaixo dele.
     *
     * Consumido pelo card de alerta do Dashboard, que faz polling a cada 30s.
     * Precisa vir antes de qualquer handler de /produtos/:id para nao ser
     * capturado como se "estoque-baixo" fosse um id.
     */
    if (route === '/produtos/estoque-baixo' && method === 'GET') {
      // Quantidade em estoque e informacao de gestao, nao de atendimento —
      // exige quem cuida do cardapio (GERENTE+). `GET /produtos` continua
      // aberto porque o atendente precisa dele para montar o pedido; o que
      // fica restrito e o saldo, nao o catalogo.
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      // Estoque desligado: lista vazia, nao 403. Este endpoint alimenta um
      // alerta que faz polling de fundo em TODA tela — devolver erro encheria
      // a operacao de toast vermelho a cada 30 segundos por um modulo que a
      // empresa simplesmente nao contratou. "Nada para alertar" e a resposta
      // honesta aqui; o 403 fica para as rotas que o usuario aciona de proposito.
      if (!temModulo(await empresaAtual(), 'estoque')) return json({ produtos: [] })
      const produtos = await produtoRepo.listEstoqueBaixo(ctx.empresa_id)
      return json({ produtos: produtos.map(clean) })
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
        // Encontrado em 2026-08-16 rodando backend_test_estoque.py pela
        // primeira vez (A1): estes tres campos nunca foram gravados na
        // criacao — o toggle "Rastrear Estoque" do dialog era um no-op
        // silencioso desde que a Estoque MVP foi entregue. Mesmo padrao das
        // funcoes atomicas do Postgres (lista explicita de coluna descarta o
        // que nao esta nela), so que aqui e o handler puro em JS.
        estoque_habilitado: b.estoque_habilitado === true,
        estoque_quantidade: b.estoque_quantidade !== undefined ? Number(b.estoque_quantidade) : null,
        estoque_minimo: b.estoque_minimo !== undefined ? Number(b.estoque_minimo) : 0,
        custo: b.custo !== undefined && b.custo !== null ? Number(b.custo) : null,
        created_at: new Date(),
      }
      await produtoRepo.create(doc)
      await audit(repos, ctx, 'create', 'produto', doc.id, { nome: b.nome, preco: doc.preco })
      return json(clean(doc), 201)
    }
    /**
     * GET /produtos/:id — produto unico.
     *
     * Faltava por completo (achado em 2026-08-16, A1): so existia list-all e
     * PUT/DELETE por id. Precisa vir depois de /produtos/estoque-baixo — se
     * viesse antes, "estoque-baixo" seria capturado como se fosse um :id.
     */
    if (seg[0] === 'produtos' && seg[1] && method === 'GET') {
      const produto = await produtoRepo.findById(ctx.empresa_id, seg[1])
      if (!produto) return err('Produto nao encontrado', 404)
      return json(clean(produto))
    }
    if (seg[0] === 'produtos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'cardapio')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const upd = {}
      // estoque_habilitado/estoque_quantidade/estoque_minimo faltavam desta
      // lista (achado em 2026-08-16, A1) — editar um produto existente para
      // ligar o rastreamento de estoque nunca persistia, em silencio.
      for (const k of ['categoria_id', 'nome', 'descricao', 'imagem', 'disponivel', 'ativo', 'estoque_habilitado']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.preco !== undefined) upd.preco = Number(b.preco)
      if (b.estoque_quantidade !== undefined) upd.estoque_quantidade = b.estoque_quantidade === null ? null : Number(b.estoque_quantidade)
      if (b.estoque_minimo !== undefined) upd.estoque_minimo = Number(b.estoque_minimo)
      if (b.custo !== undefined) upd.custo = b.custo === null ? null : Number(b.custo)
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

    /* ==================== ENTREGADORES ==================== */
    if (route === '/entregadores' && method === 'GET') {
      const url = new URL(request.url)
      const ativo = url.searchParams.get('ativo')
      try {
        const list = await entregadorRepo.listByEmpresa(
          ctx.empresa_id,
          ativo === 'true' ? true : ativo === 'false' ? false : undefined
        )
        return json(list.map(clean))
      } catch (e) {
        return err(e.message)
      }
    }
    if (route === '/entregadores' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.nome) return err('nome obrigatorio')
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        nome: b.nome,
        telefone: b.telefone || '',
        ativo: true,
        created_at: new Date(),
      }
      await entregadorRepo.create(doc)
      await audit(repos, ctx, 'create', 'entregador', doc.id, { nome: b.nome })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'entregadores' && seg[1] && method === 'PUT') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const entregador = await entregadorRepo.findById(ctx.empresa_id, seg[1])
      if (!entregador) return err('Entregador nao encontrado', 404)
      const upd = {}
      for (const k of ['nome', 'telefone', 'ativo']) if (b[k] !== undefined) upd[k] = b[k]
      const atualizado = await entregadorRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'entregador', seg[1], upd)
      return json(clean(atualizado))
    }
    if (seg[0] === 'entregadores' && seg[1] && method === 'DELETE') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) return err('Sem permissao', 403)
      const entregador = await entregadorRepo.findById(ctx.empresa_id, seg[1])
      if (!entregador) return err('Entregador nao encontrado', 404)
      await entregadorRepo.updateAtivo(ctx.empresa_id, seg[1], false)
      await audit(repos, ctx, 'delete', 'entregador', seg[1])
      return json({ ok: true })
    }

    /* ==================== CAIXA ==================== */
    // Um portao para as cinco rotas de caixa. Vale mais que cinco checagens
    // espalhadas: rota de caixa criada depois nasce protegida por padrao.
    if (seg[0] === 'caixa') {
      const bloqueio = await exigeModulo('caixa')
      if (bloqueio) return bloqueio
    }

    // GET /caixa/atual — caixa aberto com os parciais calculados, ou null.
    if (seg[0] === 'caixa' && seg[1] === 'atual' && method === 'GET') {
      // Any authenticated user can check their caixa status (not GERENTE-only per spec)
      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return json({ caixa: null, resumo: null, movimentos: [] })
      const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
      const movimentos = await caixaMovimentoRepo.listByCaixa(ctx.empresa_id, caixa.id)
      return json({ caixa, resumo, movimentos })
    }

    // POST /caixa/abrir — GERENTE+. 409 se ja houver caixa aberto.
    if (seg[0] === 'caixa' && seg[1] === 'abrir' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para abrir caixa', 403)
      }
      const b = (await request.json()) || {}
      const valorAbertura = Number(b.valor_abertura)
      if (!Number.isFinite(valorAbertura) || valorAbertura < 0) {
        return err('valor_abertura invalido')
      }

      const jaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      if (jaAberto) return err('Ja existe um caixa aberto', 409)

      let caixa
      try {
        caixa = await caixaRepo.create({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          status: 'aberto',
          aberto_por: ctx.usuario_id,
          aberto_por_nome: ctx.nome || '',
          aberto_em: new Date().toISOString(),
          valor_abertura: Math.round(valorAbertura * 100) / 100,
          created_at: new Date().toISOString(),
        })
      } catch (e) {
        // Unique index violation: another request opened caixa between check and create
        if (e.message?.includes('unique') || e.code === '23505' || e.code === 11000) {
          return err('Ja existe um caixa aberto', 409)
        }
        throw e
      }

      await audit(repos, ctx, 'abrir', 'caixa', caixa.id, { valor_abertura: caixa.valor_abertura })
      return json({ caixa })
    }

    // GET /caixa/historico — GERENTE+. Caixas fechados, mais recentes primeiro.
    if (seg[0] === 'caixa' && seg[1] === 'historico' && method === 'GET') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao', 403)
      }
      const url = new URL(request.url)
      const limiteBruto = Number(url.searchParams.get('limite'))
      const limite = Number.isFinite(limiteBruto) && limiteBruto > 0 ? Math.min(limiteBruto, 100) : 20
      const caixas = await caixaRepo.listarFechados(ctx.empresa_id, limite)
      return json({ caixas })
    }

    // POST /caixa/fechar — GERENTE+. Calcula esperado, grava diferenca.
    if (seg[0] === 'caixa' && seg[1] === 'fechar' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para fechar caixa', 403)
      }
      const b = (await request.json()) || {}
      const valorContado = Number(b.valor_contado)
      if (!Number.isFinite(valorContado) || valorContado < 0) {
        return err('valor_contado invalido')
      }

      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return err('Nao ha caixa aberto', 409)

      const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
      const contado = Math.round(valorContado * 100) / 100
      const diferenca = Math.round((contado - resumo.valor_esperado) * 100) / 100

      // Quebra de caixa exige justificativa. O sistema registra e segue — o que
      // fazer com a diferenca e decisao do dono, nao do software.
      const observacoes = (b.observacoes || '').trim()
      if (diferenca !== 0 && !observacoes) {
        return err('Informe uma observacao explicando a diferenca do caixa')
      }

      const fechado = await caixaRepo.update(ctx.empresa_id, caixa.id, {
        status: 'fechado',
        fechado_por: ctx.usuario_id,
        fechado_por_nome: ctx.nome || '',
        fechado_em: new Date().toISOString(),
        valor_contado: contado,
        valor_esperado: resumo.valor_esperado,
        diferenca,
        observacoes,
      })

      // Verify update succeeded; if caixa was already closed, update returns null/empty
      if (!fechado) return err('Nao ha caixa aberto', 409)

      await audit(repos, ctx, 'fechar', 'caixa', caixa.id, {
        valor_esperado: resumo.valor_esperado, valor_contado: contado, diferenca,
      })
      return json({ caixa: fechado, resumo })
    }

    // POST /caixa/movimento — GERENTE+. Sangria ou suprimento no caixa aberto.
    if (seg[0] === 'caixa' && seg[1] === 'movimento' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para registrar movimento', 403)
      }
      const b = (await request.json()) || {}
      if (!['sangria', 'suprimento'].includes(b.tipo)) {
        return err('tipo deve ser sangria ou suprimento')
      }
      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')

      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return err('Nao ha caixa aberto', 409)

      // Nao se tira da gaveta mais do que ha nela.
      if (b.tipo === 'sangria') {
        const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
        if (valor > resumo.valor_esperado) {
          return err(`Sangria maior que o disponivel na gaveta (R$ ${resumo.valor_esperado.toFixed(2)})`)
        }
      }

      const movimento = await caixaMovimentoRepo.create({
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        caixa_id: caixa.id,
        tipo: b.tipo,
        valor: Math.round(valor * 100) / 100,
        motivo: b.motivo || '',
        usuario_id: ctx.usuario_id,
        usuario_nome: ctx.nome || '',
        created_at: new Date().toISOString(),
      })

      await audit(repos, ctx, 'registrar', 'caixa_movimento', movimento.id, {
        tipo: movimento.tipo, valor: movimento.valor,
      })
      return json({ movimento })
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
      const subtotal = round2(itens.reduce((s, it) => s + Number(it.preco) * Number(it.quantidade || 1), 0))

      const tipo = normPedidoTipo(b.tipo)
      let entregaTaxa = 0
      let entregaTempo = null
      let entregaEndereco = ''

      if (tipo === 'delivery') {
        const emp = await empresaRepo.findById(ctx.empresa_id)
        const deliveryConfig = emp?.config?.delivery || {}
        entregaTaxa = b.entrega_taxa !== undefined ? round2(b.entrega_taxa) : round2(deliveryConfig.taxa_padrao || 0)
        entregaTempo = b.entrega_tempo_estimado_min !== undefined ? Number(b.entrega_tempo_estimado_min) : (deliveryConfig.tempo_estimado_min || null)
        entregaEndereco = b.entrega_endereco || ''
      }

      let valores
      try { valores = computePedidoValores(subtotal, b.desconto, b.acrescimo, entregaTaxa) } catch (e) { return err(e.message) }
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
        tipo,
        pagamento: b.pagamento || 'pix',
        status: b.status || 'recebido',
        observacoes: b.observacoes || '',
        subtotal: valores.subtotal,
        desconto: valores.desconto,
        acrescimo: valores.acrescimo,
        entrega_taxa: valores.entrega_taxa,
        entrega_endereco: entregaEndereco,
        entrega_tempo_estimado_min: entregaTempo,
        total: valores.total,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await pedidoRepo.create(doc)
      await audit(repos, ctx, 'create', 'pedido', doc.id, { numero, total: valores.total })
      await emitEvent(repos, ctx, 'order.created', { pedido: clean(doc) })
      return json(clean(doc), 201)
    }
    if (seg[0] === 'pedidos' && seg[1] && method === 'PUT') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const pedido = await pedidoRepo.findById(ctx.empresa_id, seg[1])
      if (!pedido) return err('Pedido nao encontrado', 404)
      const upd = { updated_at: new Date() }
      for (const k of ['status', 'pagamento', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      // `tipo` passa pela traducao de legado, igual ao POST.
      if (b.tipo !== undefined) upd.tipo = normPedidoTipo(b.tipo, pedido.tipo)

      const finais = ['concluido', 'ENTREGUE']
      const travados = [...finais, 'cancelado', 'CANCELADO']

      const tipoAtual = upd.tipo !== undefined ? upd.tipo : pedido.tipo
      const mudarParaDelivery = tipoAtual === 'delivery' && pedido.tipo !== 'delivery'
      const mudarDeDelivery = tipoAtual !== 'delivery' && pedido.tipo === 'delivery'
      const permaneceDelivery = tipoAtual === 'delivery' && pedido.tipo === 'delivery'
      const permaneceNaoDelivery = tipoAtual !== 'delivery' && pedido.tipo !== 'delivery'

      if (mudarParaDelivery) {
        const emp = await empresaRepo.findById(ctx.empresa_id)
        const deliveryConfig = emp?.config?.delivery || {}
        upd.entrega_taxa = round2(deliveryConfig.taxa_padrao || 0)
        upd.entrega_tempo_estimado_min = deliveryConfig.tempo_estimado_min || null
        if (b.entrega_endereco !== undefined) upd.entrega_endereco = b.entrega_endereco
      } else if (mudarDeDelivery) {
        upd.entrega_taxa = 0
        upd.entrega_endereco = ''
        upd.entrega_tempo_estimado_min = null
      } else if (permaneceDelivery) {
        if (b.entrega_taxa !== undefined) upd.entrega_taxa = round2(b.entrega_taxa)
        if (b.entrega_tempo_estimado_min !== undefined) upd.entrega_tempo_estimado_min = Number(b.entrega_tempo_estimado_min)
        if (b.entrega_endereco !== undefined) upd.entrega_endereco = b.entrega_endereco
      } else if (permaneceNaoDelivery) {
        upd.entrega_taxa = 0
        upd.entrega_endereco = ''
        upd.entrega_tempo_estimado_min = null
      }

      /**
       * Edicao dos itens de um pedido ja criado (Fix: operador precisava
       * poder corrigir um pedido "Recebido" — trocar itens, nao so status).
       * Bloqueada junto com desconto/acrescimo pelo mesmo motivo: depois de
       * concluido/cancelado o pedido ja virou (ou nao vira mais) receita, e
       * mudar os itens por baixo deixaria o financeiro divergente em silencio.
       */
      let itensChanged = false
      if (b.itens !== undefined) {
        if (travados.includes(pedido.status)) {
          return err('Nao e possivel alterar os itens de um pedido ja concluido ou cancelado.', 409)
        }
        const itens = Array.isArray(b.itens) ? b.itens : []
        if (!itens.length) return err('Pedido precisa de ao menos 1 item')
        upd.itens = itens
        itensChanged = true
      }

      /**
       * Ajuste manual de valor (desconto/acrescimo/entrega). Recalcula o total a partir
       * do subtotal JA GRAVADO (ou, se os itens tambem mudaram nesta mesma
       * requisicao, do novo subtotal dos itens) — nunca a partir do que o
       * cliente enviar — para que ninguem consiga alterar o valor por esta rota.
       *
       * Bloqueado depois de concluido: nesse ponto o pedido ja virou receita em
       * `transacoes` e ja somou nas metricas do cliente. Mudar o total aqui
       * deixaria o financeiro divergente em silencio; o caminho correto para
       * isso e um lancamento de estorno/ajuste no financeiro.
       */
      const entregaTaxaMudou = upd.entrega_taxa !== undefined
      if (b.desconto !== undefined || b.acrescimo !== undefined || itensChanged || entregaTaxaMudou) {
        if (finais.includes(pedido.status)) {
          return err('Nao e possivel alterar o valor de um pedido ja concluido. Registre um ajuste no financeiro.', 409)
        }
        // Pedidos criados antes da migration 0015 tem subtotal 0; nesses, o
        // `total` gravado era exatamente a soma dos itens.
        const subtotalBase = itensChanged
          ? round2(upd.itens.reduce((s, it) => s + Number(it.preco) * Number(it.quantidade || 1), 0))
          : (Number(pedido.subtotal) || Number(pedido.total) || 0)
        let valores
        try {
          valores = computePedidoValores(
            subtotalBase,
            b.desconto !== undefined ? b.desconto : pedido.desconto,
            b.acrescimo !== undefined ? b.acrescimo : pedido.acrescimo,
            upd.entrega_taxa !== undefined ? upd.entrega_taxa : (Number(pedido.entrega_taxa) || 0),
          )
        } catch (e) { return err(e.message) }
        upd.subtotal = valores.subtotal
        upd.desconto = valores.desconto
        upd.acrescimo = valores.acrescimo
        upd.entrega_taxa = valores.entrega_taxa
        upd.total = valores.total
      }

      await pedidoRepo.update(ctx.empresa_id, seg[1], upd)

      // Regra de negocio: ao concluir/entregar, gera receita e atualiza metricas do cliente.
      // Usa o total JA AJUSTADO nesta mesma requisicao (`upd.total`), nao o do
      // snapshot lido antes: sem isso, ajustar o valor e concluir de uma vez so
      // lancaria a receita com o valor antigo.
      const totalFinal = upd.total !== undefined ? upd.total : pedido.total
      if (finais.includes(b.status) && !finais.includes(pedido.status)) {
        const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
        const itensVendidos = upd.itens !== undefined ? upd.itens : (pedido.itens || [])
        const custoMapa = await mapaCustoProdutos(repos, ctx, itensVendidos)
        const custo = computeCustoVenda({ itens: itensVendidos, custoPorProduto: custoMapa })
        await transacaoRepo.create({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Pedido #${pedido.numero}`,
          valor: totalFinal,
          pedido_id: pedido.id,
          forma_pagamento: pedido.pagamento || 'dinheiro',
          caixa_id: caixaAberto ? caixaAberto.id : null,
          custo_total: custo.custo_total,
          receita_com_custo: custo.receita_com_custo,
          receita_base: custo.receita_base,
          data: new Date(),
          created_at: new Date(),
        })
        if (pedido.cliente_id) {
          await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, pedido.cliente_id, totalFinal)
        }
        // NEW: Decrement stock for each item sold (if tracking enabled)
        for (const item of (pedido.itens || [])) {
          if (item.produto_id) {
            try {
              await produtoRepo.decrementarEstoque(
                ctx.empresa_id,
                item.produto_id,
                item.quantidade,
                'venda'
              )
            } catch (e) {
              // Stock error is non-fatal — log to audit and continue
              console.warn(`Stock deduction failed for produto ${item.produto_id}: ${e.message}`)
              await audit(repos, ctx, 'estoque_erro', 'pedido', pedido.id, { erro: e.message })
            }
          }
        }
      }
      await audit(repos, ctx, 'update', 'pedido', seg[1], upd)
      if (b.status) await emitEvent(repos, ctx, 'order.status_changed', { pedido_id: seg[1], numero: pedido.numero, status: b.status })
      return json(clean(await pedidoRepo.findById(ctx.empresa_id, seg[1])))
    }

    /**
     * PATCH /pedidos/:id/status — transicao de status com regras especiais
     * para saiu_para_entrega (Task 7: Delivery Completo).
     *
     * Validacoes para saiu_para_entrega:
     * - Rejeita 400 se tipo !== 'delivery'
     * - Rejeita 400 se entregador_id nao fornecido
     * - Rejeita 404 se entregador nao encontrado ou nao pertence a empresa
     * - Snapshot entregador_nome do banco (nunca do client)
     * - Stamp saiu_para_entrega_em = now()
     */
    if (seg[0] === 'pedidos' && seg[1] && seg[2] === 'status' && method === 'PATCH') {
      if (!can(ctx.papel, 'pedidos')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const pedido = await pedidoRepo.findById(ctx.empresa_id, seg[1])
      if (!pedido) return err('Pedido nao encontrado', 404)

      const novoStatus = b.status
      if (!novoStatus) return err('status e obrigatorio', 400)

      // Logica especial para saiu_para_entrega
      if (novoStatus === 'saiu_para_entrega' || novoStatus === 'SAIU_PARA_ENTREGA') {
        // Regra 1: so pedidos delivery podem sair para entrega
        if (pedido.tipo !== 'delivery') {
          return err('Apenas pedidos delivery podem ir para saiu_para_entrega', 400)
        }

        // Regra 2: entregador_id e obrigatorio
        if (!b.entregador_id) {
          return err('entregador_id e obrigatorio para saiu_para_entrega', 400)
        }

        // Regra 3: verificar que entregador existe e pertence a empresa
        const entregador = await entregadorRepo.findById(ctx.empresa_id, b.entregador_id)
        if (!entregador) {
          return err('Entregador nao encontrado', 404)
        }

        // Regra 4: snapshot entregador_nome do banco (nunca confiar no client)
        // e stamp timestamp
        const upd = {
          status: novoStatus,
          entregador_id: b.entregador_id,
          entregador_nome: entregador.nome,
          saiu_para_entrega_em: new Date().toISOString(),
          updated_at: new Date(),
        }
        await pedidoRepo.update(ctx.empresa_id, seg[1], upd)
        await audit(repos, ctx, 'update', 'pedido', seg[1], upd)
        await emitEvent(repos, ctx, 'order.status_changed', { pedido_id: seg[1], numero: pedido.numero, status: novoStatus })
        return json({ pedido: clean(await pedidoRepo.findById(ctx.empresa_id, seg[1])) }, 200)
      }

      // Para outros status, nao tem logica especial por enquanto
      // (manter extensivel para futuras regras por status)
      const upd = {
        status: novoStatus,
        updated_at: new Date(),
      }
      await pedidoRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'pedido', seg[1], upd)
      await emitEvent(repos, ctx, 'order.status_changed', { pedido_id: seg[1], numero: pedido.numero, status: novoStatus })
      return json({ pedido: clean(await pedidoRepo.findById(ctx.empresa_id, seg[1])) }, 200)
    }

    // POST /pedidos/:id/estorno — GERENTE+. Lancamento de contrapartida.
    // O `total` do pedido nunca muda; o estorno e um lancamento novo em
    // `transacoes` (tipo despesa, categoria Estorno) — exatamente o que o
    // comentario acima (edicao de valor apos concluido) ja orientava.
    if (seg[0] === 'pedidos' && seg[2] === 'estorno' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para estornar', 403)
      }
      const b = (await request.json()) || {}
      const pedido = await pedidoRepo.findById(ctx.empresa_id, seg[1])
      if (!pedido) return err('Pedido nao encontrado', 404)

      const finaisEstornaveis = ['concluido', 'ENTREGUE', 'entregue']
      if (!finaisEstornaveis.includes(pedido.status)) {
        return err('So pedidos concluidos podem ser estornados')
      }

      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')

      const motivo = (b.motivo || '').trim()
      if (!motivo) return err('motivo e obrigatorio')

      // Estorno parcial e permitido, mas a soma dos estornos nunca passa do total.
      const doPedido = await transacaoRepo.findByPedido(ctx.empresa_id, pedido.id)
      const jaEstornado = doPedido
        .filter((t) => t.tipo === 'despesa' && t.categoria === 'Estorno')
        .reduce((s, t) => s + Number(t.valor || 0), 0)

      const valorArred = Math.round(valor * 100) / 100
      if (jaEstornado + valorArred > pedido.total) {
        const restante = Math.round((pedido.total - jaEstornado) * 100) / 100
        return err(`Estorno acima do disponivel. Restam R$ ${restante.toFixed(2)} deste pedido`)
      }

      const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      const estorno = await transacaoRepo.create({
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        tipo: 'despesa',
        categoria: 'Estorno',
        descricao: `Estorno do Pedido #${pedido.numero}: ${motivo}`,
        valor: valorArred,
        pedido_id: pedido.id,
        comanda_id: pedido.comanda_id || null,
        forma_pagamento: pedido.pagamento || 'dinheiro',
        caixa_id: caixaAberto ? caixaAberto.id : null,
        data: new Date(),
        created_at: new Date(),
      })

      await audit(repos, ctx, 'estornar', 'pedido', pedido.id, { valor: valorArred, motivo })
      return json({ estorno: clean(estorno), total_estornado: Math.round((jaEstornado + valorArred) * 100) / 100 })
    }

    /* ==================== FINANCEIRO ==================== */
    if (route === '/financeiro/transacoes' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const list = await transacaoRepo.listRecentes(ctx.empresa_id, 500)
      return json(list.map(clean))
    }
    if (route === '/financeiro/categorias-despesa' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      return json(CATEGORIAS_DESPESA)
    }
    if (route === '/financeiro/transacoes' && method === 'POST') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!b.tipo || b.valor === undefined) return err('tipo e valor obrigatorios')
      // NULL = nao classificada, nunca inventado como 'fixa' ou 'variavel' por
      // default — mesma regra de nao-adivinhar de produtos.custo (0020) e
      // cardapio_imagem_url (0021). Uma despesa sem natureza entra no DRE como
      // "nao classificada", visivel, em vez de distorcer silenciosamente o
      // ponto de equilibrio.
      const natureza = ['fixa', 'variavel'].includes(b.natureza) ? b.natureza : null
      const doc = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        tipo: b.tipo,
        categoria: b.categoria || 'Outros',
        natureza,
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

    /* ==================== CONTAS A PAGAR/RECEBER ====================
     * Camada de OBRIGACAO (o que ainda vai vencer), complementar a
     * `transacoes` (a camada de CAIXA — o que ja aconteceu). Uma conta so
     * entra em qualquer numero do relatorio financeiro (DRE, CMV, margem)
     * depois de PAGA, porque so ai vira uma `transacao` de verdade — ver o
     * handler de /contas/:id/pagar abaixo. Antes disso e so previsao,
     * invisivel para o relatorio de proposito: contar como despesa um boleto
     * que ainda nao saiu do bolso inflaria o resultado com dinheiro que nao
     * mudou de mao.
     */
    if (route === '/contas' && method === 'GET') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const url = new URL(request.url)
      const fTipo = url.searchParams.get('tipo')
      const fStatus = url.searchParams.get('status') // 'pendente' | 'paga' | 'cancelada' | 'atrasada'

      const todas = (await contaRepo.list(ctx.empresa_id)).map((c) => ({ ...c, status_efetivo: statusEfetivo(c) }))
      let filtradas = todas
      if (fTipo && fTipo !== 'todos') filtradas = filtradas.filter((c) => c.tipo === fTipo)
      if (fStatus && fStatus !== 'todos') filtradas = filtradas.filter((c) => c.status_efetivo === fStatus)

      return json({
        contas: filtradas.map(clean),
        // Resumo sempre sobre a lista INTEIRA da empresa, nunca sobre a
        // filtrada — o card "contas a vencer" nao pode mudar de valor so
        // porque o operador filtrou a tabela por "receber".
        resumo: resumoContas(todas),
      })
    }

    if (route === '/contas' && method === 'POST') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      if (!['pagar', 'receber'].includes(b.tipo)) return err('tipo deve ser "pagar" ou "receber"')
      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')
      if (!b.vencimento) return err('vencimento obrigatorio')
      // Mesma regra de nao-adivinhar de transacoes.natureza (0022): so grava
      // se o valor enviado for exatamente um dos dois validos.
      const natureza = ['fixa', 'variavel'].includes(b.natureza) ? b.natureza : null

      // `repeticoes` gera a serie INTEIRA de uma vez, aqui no cadastro — nao
      // e um motor de recorrencia que cria parcela nova sozinha todo mes
      // (migration 0026). Cada parcela nasce como conta independente, so
      // ligada pelo `serie_id` pra a tela rotular "3 de 12"; pagar, cancelar
      // ou editar uma nao afeta as outras. Teto de 60 (5 anos de mensal)
      // evita um numero digitado errado (ex: confundir com o valor)
      // gerar milhares de registros.
      const repeticoes = b.repeticoes !== undefined ? Number(b.repeticoes) : 1
      if (!Number.isInteger(repeticoes) || repeticoes < 1 || repeticoes > 60) {
        return err('repeticoes deve ser um numero inteiro entre 1 e 60')
      }

      const serieId = repeticoes > 1 ? uuidv4() : null
      const descricaoBase = b.descricao || ''
      const criadas = []
      for (let i = 0; i < repeticoes; i++) {
        const doc = {
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: b.tipo,
          // So numera quando ha mais de uma parcela — conta avulsa nao
          // ganha "(1/1)" pendurado no nome por acidente de implementacao.
          descricao: repeticoes > 1 ? `${descricaoBase} (${i + 1}/${repeticoes})`.trim() : descricaoBase,
          categoria: b.categoria || 'Outros',
          natureza,
          valor: round2(valor),
          // Primeira parcela usa a data exata que veio do formulario; as
          // seguintes somam meses em cima dela (nunca em cima da anterior —
          // evita deriva de arredondamento acumulada ao longo de 60 parcelas).
          vencimento: i === 0 ? b.vencimento : adicionarMeses(b.vencimento, i),
          status: 'pendente',
          pago_em: null,
          transacao_id: null,
          observacoes: b.observacoes || '',
          serie_id: serieId,
          serie_indice: repeticoes > 1 ? i + 1 : null,
          serie_total: repeticoes > 1 ? repeticoes : null,
          created_at: new Date(),
          updated_at: new Date(),
        }
        await contaRepo.create(doc)
        criadas.push(doc)
      }
      await audit(repos, ctx, 'create', 'conta', criadas[0].id, {
        tipo: b.tipo, valor: round2(valor), vencimento: b.vencimento,
        ...(repeticoes > 1 ? { serie_id: serieId, repeticoes } : {}),
      })

      const limpar = (d) => clean({ ...d, status_efetivo: statusEfetivo(d) })
      // O formato da resposta so muda quando ha mais de uma parcela — o
      // caso comum (conta avulsa) continua devolvendo um objeto so, pra nao
      // quebrar quem ja consome este endpoint esperando isso.
      if (repeticoes > 1) return json({ contas: criadas.map(limpar), serie_id: serieId }, 201)
      return json(limpar(criadas[0]), 201)
    }

    if (seg[0] === 'contas' && seg[1] && method === 'PUT' && !seg[2]) {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const conta = await contaRepo.findById(ctx.empresa_id, seg[1])
      if (!conta) return err('Conta nao encontrada', 404)
      // So edita enquanto pendente — mesma regra de "pedido concluido nao se
      // edita" (decisao #6 do HANDOFF): uma conta ja paga virou transacao de
      // verdade, e corrigir o registro por baixo do relatorio sem gerar
      // rastro seria pior que recusar a edicao.
      if (conta.status !== 'pendente') return err(`Conta ${conta.status} nao pode ser editada`, 409)
      const b = (await request.json()) || {}
      const upd = { updated_at: new Date() }
      for (const k of ['descricao', 'categoria', 'observacoes']) if (b[k] !== undefined) upd[k] = b[k]
      if (b.valor !== undefined) {
        const valor = Number(b.valor)
        if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')
        upd.valor = round2(valor)
      }
      if (b.vencimento !== undefined) upd.vencimento = b.vencimento
      if (b.natureza !== undefined) upd.natureza = ['fixa', 'variavel'].includes(b.natureza) ? b.natureza : null
      const atualizada = await contaRepo.update(ctx.empresa_id, seg[1], upd)
      await audit(repos, ctx, 'update', 'conta', seg[1], upd)
      return json(clean({ ...atualizada, status_efetivo: statusEfetivo(atualizada) }))
    }

    if (seg[0] === 'contas' && seg[1] && seg[2] === 'pagar' && method === 'PUT') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const conta = await contaRepo.findById(ctx.empresa_id, seg[1])
      if (!conta) return err('Conta nao encontrada', 404)
      if (conta.status !== 'pendente') return err(`Conta ja esta ${conta.status}`, 409)
      const b = (await request.json()) || {}
      // A data em que o dinheiro de fato mudou de mao — nunca o vencimento.
      // Um boleto que vencia em junho e so foi pago em julho e despesa de
      // julho no caixa: e a mesma logica de regime de caixa que o resto do
      // relatorio financeiro ja usa (`transacoes.data`, nao a data do pedido).
      const pagoEm = b.data ? new Date(b.data) : new Date()

      const transacao = {
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        tipo: conta.tipo === 'pagar' ? 'despesa' : 'receita',
        categoria: conta.categoria,
        natureza: conta.natureza,
        descricao: conta.descricao || `Conta ${conta.tipo === 'pagar' ? 'paga' : 'recebida'}`,
        valor: conta.valor,
        pedido_id: null,
        data: pagoEm,
        created_at: new Date(),
      }
      await transacaoRepo.create(transacao)
      const atualizada = await contaRepo.update(ctx.empresa_id, seg[1], {
        status: 'paga', pago_em: pagoEm, transacao_id: transacao.id, updated_at: new Date(),
      })
      await audit(repos, ctx, 'pagar', 'conta', seg[1], { transacao_id: transacao.id, valor: conta.valor })
      return json(clean({ ...atualizada, status_efetivo: statusEfetivo(atualizada) }))
    }

    if (seg[0] === 'contas' && seg[1] && seg[2] === 'cancelar' && method === 'PUT') {
      if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)
      const conta = await contaRepo.findById(ctx.empresa_id, seg[1])
      if (!conta) return err('Conta nao encontrada', 404)
      if (conta.status !== 'pendente') return err(`Conta ja esta ${conta.status}`, 409)
      const atualizada = await contaRepo.update(ctx.empresa_id, seg[1], { status: 'cancelada', updated_at: new Date() })
      await audit(repos, ctx, 'cancelar', 'conta', seg[1], {})
      return json(clean({ ...atualizada, status_efetivo: statusEfetivo(atualizada) }))
    }

    /* ==================== DASHBOARD ==================== */
    if (route === '/dashboard/metrics' && method === 'GET') {
      // Este endpoint devolve faturamento do dia, ticket medio e alerta de
      // estoque. Ficou SEM checagem nenhuma ate 2026-08-18: bastava estar
      // logado. Tirar o item do menu no front esconderia o botao e deixaria a
      // rota aberta — a mesma falha das feature flags (B1), onde a tela dizia
      // uma coisa e o servidor permitia outra.
      if (!can(ctx.papel, 'dashboard')) return err('Sem permissao', 403)
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

      // Mesmo recorte de `receitaHoje`: so o que entrou hoje.
      const cmv = computeCMV(transacoes.filter((t) => new Date(t.data) >= today))

      return json({
        faturamentoHoje: Math.round(receitaHoje * 100) / 100,
        pedidosHoje: pedidosHoje.length,
        ticketMedio: Math.round(ticketMedio * 100) / 100,
        totalClientes: clientes,
        totalProdutos: produtos.length,
        serie, topProdutos, recentes, porStatus,
        cmv: (can(ctx.papel, 'relatorios') || can(ctx.papel, 'financeiro')) ? cmv : null,
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
        // Nunca expor credenciais sensiveis (access token / api key / segredo
        // de webhook) ao client — so sinalizar presenca via booleano.
        if (c.tipo === 'mercadopago' && c.config) {
          c.config = { mode: c.config.mode || 'sandbox', hasAccessToken: Boolean(c.config.accessToken), hasWebhookSecret: Boolean(c.config.webhookSecret) }
        }
        if (c.tipo === 'evolution' && c.config) {
          c.config = { serverUrl: c.config.serverUrl || '', instance: c.config.instance || 'restaurant-os', hasApiKey: Boolean(c.config.apiKey), hasWebhookSecret: Boolean(c.config.webhookSecret) }
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
      const current = await integracaoRepo.findByTipo(ctx.empresa_id, 'evolution')
      // Segredo do webhook: gerado automaticamente na primeira vez (nunca
      // pedido ao usuario) e preservado nas edicoes seguintes, a menos que a
      // troca seja pedida explicitamente. E o valor que o dono cola na
      // configuracao de webhook da Evolution API (query param ?secret=...)
      // para provar que a chamada em /whatsapp/webhook e mesmo dela.
      const webhookSecret = b.webhookSecret !== undefined && b.webhookSecret !== ''
        ? b.webhookSecret
        : current?.config?.webhookSecret || crypto.randomBytes(24).toString('hex')
      const config = { serverUrl: b.serverUrl || '', apiKey: b.apiKey || '', instance: b.instance || 'restaurant-os', webhookSecret }
      const status = config.serverUrl && config.apiKey ? 'configurado' : 'nao_configurado'
      const atualizado = await integracaoRepo.upsert(ctx.empresa_id, 'evolution', { config, status })
      await audit(repos, ctx, 'update', 'integracao', 'evolution', { status })
      // clean() so remove _id/senha_hash: o config volta completo (incluindo
      // webhookSecret) so nesta resposta, para o dono copiar e colar na
      // configuracao de webhook da Evolution API. GET /integracoes mascara
      // (linha ~1716) e nunca devolve o valor de novo depois deste PUT.
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
    // Portao unico de mesas + comandas: as duas superficies sao um modulo so
    // ("Mesas & Comandas" na tela), e uma comanda so existe sobre uma mesa.
    if (seg[0] === 'mesas' || seg[0] === 'comandas') {
      const bloqueio = await exigeModulo('mesas')
      if (bloqueio) return bloqueio
    }

    if (route === '/mesas' && method === 'GET') {
      if (!can(ctx.papel, 'mesas')) return err('Sem permissao', 403)
      const mesas = await mesaRepo.list(ctx.empresa_id, { ativo: true })
      // anexa resumo da comanda aberta
      const comandaIds = mesas.map((m) => m.comanda_id).filter(Boolean)
      const comandas = comandaIds.length ? await comandaRepo.findManyByIds(ctx.empresa_id, comandaIds) : []
      const byId = Object.fromEntries(comandas.map((c) => [c.id, c]))
      const out = mesas.map((m) => {
        const c = m.comanda_id ? byId[m.comanda_id] : null
        const itens = c?.itens || []
        // `entregue` e o unico campo de estagio que os itens de comanda realmente
        // tem (ver /kds/pendentes): nao ha recebido/em_preparo distintos aqui,
        // so pendente (ainda nao levado a mesa) vs entregue.
        const itens_pendentes = itens.filter((it) => !it.entregue).length
        const itens_entregues = itens.filter((it) => it.entregue).length
        return { ...clean(m), comanda: c ? { id: c.id, total: c.total, pessoas: c.pessoas, cliente_nome: c.cliente_nome, itens_count: itens.length, itens_pendentes, itens_entregues, aberta_em: c.aberta_em } : null }
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
      await comandaRepo.pushPagamentoResumo(ctx.empresa_id, comanda.id, {
        id: pagamento.id, metodo: pagamento.metodo, valor: pagamento.valor,
        status: pagamento.status, provider: pagamento.provider, created_at: pagamento.created_at,
      })
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
      // Uma transacao por metodo de pagamento. Comanda com conta dividida
      // (metade cartao, metade dinheiro) precisa das duas linhas: sem isso a
      // conferencia da gaveta nunca fecha e o relatorio por forma de pagamento
      // fica errado.
      const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      const pagamentos = comanda.pagamentos || []
      const custoMapa = await mapaCustoProdutos(repos, ctx, comanda.itens)

      if (pagamentos.length > 0) {
        for (const pg of pagamentos) {
          // Rateio: que fatia desta venda esta transacao representa. A soma dos
          // rateios e 1, entao a soma dos campos de custo fecha com o total.
          const rateio = totals.total > 0 ? pg.valor / totals.total : 0
          const custo = computeCustoVenda({ itens: comanda.itens, custoPorProduto: custoMapa, rateio })
          await transacaoRepo.create({
            id: uuidv4(),
            empresa_id: ctx.empresa_id,
            tipo: 'receita',
            categoria: 'Vendas',
            descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero}) - ${pg.metodo}`,
            valor: pg.valor,
            pedido_id: pedido.id,
            comanda_id: comanda.id,
            forma_pagamento: pg.metodo,
            caixa_id: caixaAberto ? caixaAberto.id : null,
            custo_total: custo.custo_total,
            receita_com_custo: custo.receita_com_custo,
            receita_base: custo.receita_base,
            data: new Date(),
            created_at: new Date(),
          })
        }
      } else {
        // Comanda fechada sem registro de pagamento (fluxo antigo): mantem o
        // comportamento atual, uma transacao unica, assumindo dinheiro.
        const custoUnico = computeCustoVenda({ itens: comanda.itens, custoPorProduto: custoMapa })
        await transacaoRepo.create({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero})`,
          valor: totals.total,
          pedido_id: pedido.id,
          comanda_id: comanda.id,
          forma_pagamento: 'dinheiro',
          caixa_id: caixaAberto ? caixaAberto.id : null,
          custo_total: custoUnico.custo_total,
          receita_com_custo: custoUnico.receita_com_custo,
          receita_base: custoUnico.receita_base,
          data: new Date(),
          created_at: new Date(),
        })
      }
      if (comanda.cliente_id) await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, comanda.cliente_id, totals.total)
      // NEW: Decrement stock for each item sold (if tracking enabled)
      for (const item of (comanda.itens || [])) {
        if (item.produto_id) {
          try {
            await produtoRepo.decrementarEstoque(
              ctx.empresa_id,
              item.produto_id,
              item.quantidade,
              'venda'
            )
          } catch (e) {
            console.warn(`Stock deduction failed for produto ${item.produto_id}: ${e.message}`)
            await audit(repos, ctx, 'estoque_erro', 'comanda', comanda.id, { erro: e.message })
          }
        }
      }
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
      /**
       * Os mesmos filtros da tela aplicados a uma janela qualquer. Existe para
       * que o periodo anterior seja apurado com regra IDENTICA a do atual —
       * duplicar os filtros para o comparativo abriria espaco para os dois
       * lados divergirem e a variacao mentir sem ninguem notar.
       */
      const recortar = (de, ate) => {
        const dentro = (d) => { const x = new Date(d); return x >= de && x <= ate }
        let peds = pedidosAll.filter((p) => dentro(p.created_at))
        if (fPag && fPag !== 'todos') peds = peds.filter((p) => p.pagamento === fPag)
        if (fStatus && fStatus !== 'todos') peds = peds.filter((p) => normPedidoStatus(p.status) === fStatus)
        if (fTipo && fTipo !== 'todos') peds = peds.filter((p) => p.tipo === fTipo)
        return {
          pedidos: peds,
          trans: transAll.filter((t) => dentro(t.data)),
          pags: pagsAll.filter((p) => dentro(p.created_at)),
        }
      }

      /** Indicadores de uma janela — usado no periodo atual e no anterior. */
      const apurar = ({ pedidos, trans, pags }) => {
        const faturados = pedidos.filter((p) => ['concluido', 'ENTREGUE'].includes(p.status))
        const cancelados = pedidos.filter((p) => ['cancelado', 'CANCELADO'].includes(p.status))
        const receitas = round2(trans.filter((t) => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0))
        const despesas = round2(trans.filter((t) => t.tipo === 'despesa').reduce((s, t) => s + t.valor, 0))
        const cmv = computeCMV(trans)
        const despesasPorCategoria = agruparDespesasPorCategoria(trans)
        const dre = computeDRE({ cmv, receitaTotal: receitas, despesasPorCategoria })
        const faturamentoBruto = round2(faturados.reduce((s, p) => s + p.total, 0))
        const recebidos = round2(pags.filter((p) => p.status === 'approved').reduce((s, p) => s + p.valor, 0))
        const pendentes = round2(pags.filter((p) => p.status === 'pending').reduce((s, p) => s + p.valor, 0))
        const reembolsados = round2(pags.filter((p) => ['refunded', 'cancelled'].includes(p.status)).reduce((s, p) => s + p.valor, 0))
        return {
          faturados, cancelados, receitas, despesas, cmv, despesasPorCategoria, dre,
          faturamentoBruto, recebidos, pendentes, reembolsados,
          total_pedidos: pedidos.length,
          ticket_medio: faturados.length ? round2(faturamentoBruto / faturados.length) : 0,
        }
      }

      const janelaAtual = recortar(inicio, fim)
      const pedidos = janelaAtual.pedidos
      const trans = janelaAtual.trans
      const pags = janelaAtual.pags
      const A = apurar(janelaAtual)

      const janelaAnterior = periodoAnterior(inicio, fim)
      const P = apurar(recortar(janelaAnterior.inicio, janelaAnterior.fim))

      const faturados = A.faturados
      const cancelados = A.cancelados
      const { receitas, despesas, cmv, despesasPorCategoria, dre, faturamentoBruto, recebidos, pendentes, reembolsados } = A

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
          ticket_medio: A.ticket_medio,
          receitas, despesas, saldo: round2(receitas - despesas),
          recebidos, pendentes, cancelados_reembolsados: round2(cancelados.reduce((s, p) => s + p.total, 0) + reembolsados),
        },
        cmv,
        dre,
        despesas_por_categoria: despesasPorCategoria,
        /**
         * Margem bruta por canal. O total consolidado esconde que o delivery
         * pode estar vendendo bem e ganhando pouco.
         */
        margem_por_canal: computeMargemPorCanal({ transacoes: trans, pedidos }),
        /**
         * Ranking por produto usa CUSTO ATUAL, nao o congelado na venda — ver
         * a nota grande em computeMargemPorProduto. `faturados`, no mesmo
         * criterio do faturamento bruto do periodo.
         */
        margem_por_produto: computeMargemPorProduto({
          pedidos: faturados,
          produtos: await produtoRepo.list(ctx.empresa_id),
        }),
        /**
         * Comparativo com a janela imediatamente anterior de mesma duracao.
         * Sem isso todo numero do relatorio e um retrato solto: R$ 40 mil de
         * faturamento nao diz nada sozinho — diz muito ao lado dos R$ 52 mil
         * do periodo anterior.
         */
        comparativo: {
          periodo: janelaAnterior,
          faturamento_bruto: computeVariacao(faturamentoBruto, P.faturamentoBruto),
          receitas: computeVariacao(receitas, P.receitas),
          despesas: computeVariacao(despesas, P.despesas),
          ticket_medio: computeVariacao(A.ticket_medio, P.ticket_medio),
          total_pedidos: computeVariacao(A.total_pedidos, P.total_pedidos),
          lucro_liquido: computeVariacao(dre.lucro_liquido, P.dre.lucro_liquido),
          // CMV% pode ser null dos dois lados (sem custo cadastrado); a
          // variacao so faz sentido quando ha base nos dois periodos.
          cmv_percent: cmv.cmv_percent !== null && P.cmv.cmv_percent !== null
            ? computeVariacao(cmv.cmv_percent, P.cmv.cmv_percent)
            : null,
        },
        serie, porFormaPagamento, tabela,
      })
    }

    return err(`Rota ${route} nao encontrada`, 404)
  } catch (e) {
    console.error('API Error:', e)
    // Fire-and-forget: nunca aguardado (`await` atrasaria a resposta de erro
    // que o usuario ja esta esperando) e `.catch()` extra por seguranca —
    // capturarErro() ja nao lanca sozinha, mas uma promise rejeitada sem
    // handler ainda produziria um unhandledRejection no processo do Node.
    capturarErro(e, { empresa_id: ctxParaErro?.empresa_id, rota: route, metodo: method }).catch(() => {})
    return err('Erro interno do servidor', 500)
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
export const PATCH = handler
