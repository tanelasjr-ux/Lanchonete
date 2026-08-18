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

module.exports = { registrarEmpresa, autenticarComo, criarProduto, criarPedido, nomeUnico }
