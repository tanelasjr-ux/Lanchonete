// @ts-check
const { test, expect } = require('@playwright/test')
const { registrarEmpresa, autenticarComo, criarProduto, criarPedido } = require('./helpers')

test.describe('KDS (Cozinha)', () => {
  test('marcar item pronto some do painel da cozinha', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'KDS Fluxo')
    const produto = await criarProduto(request, token, { nome: 'Item KDS E2E', preco: 22 })
    // `/kds/pendentes` mostra pedido com status 'novo'/'em_preparacao' (ver
    // route.js) — um pedido recem-criado ('recebido') ja aparece, sem
    // precisar avancar o fluxo primeiro.
    await criarPedido(request, token, { produtoId: produto.id, nome: produto.nome, preco: 22 })

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Cozinha' }).click()

    await expect(page.getByText(produto.nome)).toBeVisible()
    await expect(page.getByText('Toque para concluir').first()).toBeVisible()

    // O card inteiro e clicavel (nao ha botao com nome acessivel proprio —
    // ver components/kds.jsx, ItemCard usa onClick no Card).
    await page.getByText(produto.nome).click()

    await expect(page.getByText(produto.nome)).not.toBeVisible()
  })

  test('painel vazio mostra mensagem de nenhum pedido pendente', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'KDS Vazio')

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Cozinha' }).click()
    await expect(page.getByText('Nenhum pedido pendente')).toBeVisible()
  })
})
