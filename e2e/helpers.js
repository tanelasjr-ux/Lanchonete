/**
 * Helpers da suite E2E (item A4). Setup de precondicao passa pela API
 * (rapido, determinístico); o FLUXO sendo testado sempre passa pela tela de
 * verdade — misturar os dois seria testar a API de novo com passos extras,
 * nao testar a UI.
 */

let contador = 0
/** Nome unico por teste, sem depender de timestamp (paralelismo futuro nao colide). */
function nomeUnico(prefixo) {
  contador += 1
  return `${prefixo} ${Date.now()}-${contador}`
}

/**
 * Registra uma empresa nova via API e devolve o necessario pra autenticar a
 * pagina direto, sem passar pela tela de cadastro (cadastro em si nao e um
 * dos fluxos criticos listados no PROFISSIONALIZACAO.md — login e).
 */
async function registrarEmpresa(request, prefixoNome = 'E2E') {
  const nome = nomeUnico(prefixoNome)
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@teste.com`
  const senha = 'senha12345'
  const resp = await request.post('/api/auth/register', {
    data: { empresa_nome: nome, nome: 'Dono E2E', email, senha },
  })
  if (!resp.ok()) {
    throw new Error(`registro falhou: ${resp.status()} ${await resp.text()}`)
  }
  const corpo = await resp.json()
  return { token: corpo.token, email, senha, empresaId: corpo.empresa.id, empresaNome: nome }
}

/**
 * Injeta o token no localStorage e recarrega — mesmo mecanismo de
 * autenticacao que a tela usa (`localStorage['ros_token']`, ver `app/page.js`).
 * `page.goto` precisa acontecer ANTES do `addInitScript`/`evaluate` conseguir
 * tocar em localStorage (a origem so existe apos a primeira navegacao).
 */
async function autenticarComo(page, token) {
  await page.goto('/')
  await page.evaluate((t) => localStorage.setItem('ros_token', t), token)
  await page.goto('/')
}

/** Cria um produto simples via API — precondicao de varios fluxos (pedido, comanda). */
async function criarProduto(request, token, { nome = 'Produto E2E', preco = 25, custo } = {}) {
  const body = { nome, preco }
  if (custo !== undefined) body.custo = custo
  const resp = await request.post('/api/produtos', {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  })
  if (!resp.ok()) throw new Error(`criar produto falhou: ${resp.status()} ${await resp.text()}`)
  return resp.json()
}

/**
 * Cria um pedido via API — precondicao pra fluxos que testam outra coisa
 * (ex: KDS testa "marcar pronto", nao "criar pedido", que ja tem cobertura
 * propria em pedido.spec.js). `preco` vai explicito porque o servidor
 * confia no que o cliente manda, nao busca pelo produto_id (ver route.js).
 */
async function criarPedido(request, token, { produtoId, nome, preco, quantidade = 1, tipo = 'para_levar' } = {}) {
  const resp = await request.post('/api/pedidos', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      tipo, cliente_nome: 'Cliente E2E', pagamento: 'pix',
      // `nome` vai explicito porque o servidor grava o item como veio no
      // corpo — nunca deriva de `produto_id` (mesma regra do `preco`, ver
      // route.js). Esquecer isso faz o item chegar sem nome em qualquer
      // lugar que o exiba (KDS, cupom, relatorio).
      itens: [{ produto_id: produtoId, nome, preco, quantidade }],
    },
  })
  if (!resp.ok()) throw new Error(`criar pedido falhou: ${resp.status()} ${await resp.text()}`)
  return resp.json()
}

/**
 * Cria as mesas de demonstracao via API.
 *
 * Ate o B2 (onboarding guiado, 2026-08-19) o proprio `POST /auth/register`
 * rodava o seed, entao toda empresa nova ja nascia com mesas 'livre' e os
 * testes de mesa/comanda contavam com isso sem dizer. O B2 tirou o seed do
 * cadastro e o transformou em `POST /empresa/seed-demo`, sob demanda — as
 * suites Python foram atualizadas na epoca, mas os E2E nao, e o de comanda
 * passou a falhar procurando uma mesa 'Livre' que nunca era criada. Quem
 * precisa de mesa pre-existente chama isto explicitamente.
 */
async function semearDadosDemo(request, token) {
  const resp = await request.post('/api/empresa/seed-demo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok()) throw new Error(`seed demo falhou: ${resp.status()} ${await resp.text()}`)
  return resp.json()
}

/**
 * Coloca a empresa no plano Completo pelo MESMO caminho do Painel ETNA:
 * `PUT /plataforma/empresas/:id/assinatura` chamado por um admin da
 * plataforma (que tambem sincroniza `empresa.config.plano`).
 *
 * Por que existe: desde os Planos Basico/Completo (2026-08-25), empresa nova
 * nasce no Basico, e Estoque/Caixa/Financeiro so existem no Completo — o
 * botao "Financeiro" some da navegacao e o caixa.spec passou a falhar
 * esperando por ele (os specs nao foram atualizados junto com os planos).
 *
 * Admin de plataforma nao tem endpoint de criacao, de proposito (HANDOFF §9,
 * decisao 11: "sem endpoint de auto-promocao"). Entao o admin de TESTE e
 * gravado direto na colecao `plataforma_admins` do MongoDB descartavel da
 * suite. O global-setup.js ja garantiu que o servidor esta em Mongo; aqui
 * conferimos de novo a variavel antes de abrir qualquer conexao.
 */
let adminCache = null
async function tokenAdminPlataforma(request) {
  if (adminCache) return adminCache
  if (process.env.DATABASE_PROVIDER === 'supabase') {
    throw new Error('[e2e] recusado: DATABASE_PROVIDER=supabase — nunca promover admin fora do Mongo de teste')
  }
  const { MongoClient } = require('mongodb')
  const admin = await registrarEmpresa(request, 'Admin Plataforma E2E')
  const cliente = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017')
  try {
    await cliente.connect()
    await cliente
      .db(process.env.DB_NAME || 'restaurant_os_e2e')
      .collection('plataforma_admins')
      .insertOne({ id: `e2e-${Date.now()}`, email: admin.email, ativo: true, created_at: new Date() })
  } finally {
    await cliente.close()
  }
  adminCache = admin.token
  return adminCache
}

async function contratarPlanoCompleto(request, empresaId) {
  const token = await tokenAdminPlataforma(request)
  const vence = new Date()
  vence.setMonth(vence.getMonth() + 1)
  const resp = await request.put(`/api/plataforma/empresas/${empresaId}/assinatura`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { plano: 'completo', valor: 0, dia_vencimento: 10, proximo_vencimento: vence.toISOString().slice(0, 10) },
  })
  if (!resp.ok()) throw new Error(`contratar plano completo falhou: ${resp.status()} ${await resp.text()}`)
  return resp.json()
}

module.exports = { registrarEmpresa, autenticarComo, criarProduto, criarPedido, semearDadosDemo, contratarPlanoCompleto, nomeUnico }
