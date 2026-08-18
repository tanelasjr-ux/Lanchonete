// @ts-check
const { test, expect } = require('@playwright/test')
const { registrarEmpresa, autenticarComo, criarProduto } = require('./helpers')

test.describe('Pedido', () => {
  test('criar pedido e avancar ate concluido', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'Pedido Fluxo')
    const produto = await criarProduto(request, token, { nome: 'Burger Teste E2E', preco: 30 })

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Pedidos' }).click()
    await page.getByRole('button', { name: 'Novo pedido' }).click()

    await page.getByRole('button', { name: new RegExp(produto.nome) }).click()
    await page.getByRole('button', { name: 'Criar pedido' }).click()
    await expect(page.getByText('Pedido criado')).toBeVisible()

    // Card do pedido novo, identificado pelo nome do produto dentro dele —
    // nao pelo numero, que depende de quantos pedidos o seed ja criou.
    const card = page.locator('div', { hasText: produto.nome }).filter({ has: page.getByRole('button', { name: /Em Preparo|Pronto|Concluído/ }) }).last()

    await card.getByRole('button', { name: 'Em Preparo' }).click()
    await expect(card.getByRole('button', { name: 'Pronto' })).toBeVisible()
    await card.getByRole('button', { name: 'Pronto' }).click()
    await expect(card.getByRole('button', { name: 'Concluído' })).toBeVisible()
    await card.getByRole('button', { name: 'Concluído' }).click()

    // Concluido sai do fluxo ativo (card nao mostra mais botao de avancar) —
    // a prova final e que a transacao de receita foi gerada no financeiro.
    await page.getByRole('button', { name: 'Financeiro' }).click();
    await page.getByRole('tab', { name: 'Lançamentos' }).click()
    await expect(page.getByText(`Pedido #`).first()).toBeVisible()
  })

  test('cancelar pedido recebido', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'Pedido Cancelar')
    const produto = await criarProduto(request, token, { nome: 'Item Cancelavel E2E', preco: 15 })

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Pedidos' }).click()
    await page.getByRole('button', { name: 'Novo pedido' }).click()
    await page.getByRole('button', { name: new RegExp(produto.nome) }).click()
    await page.getByRole('button', { name: 'Criar pedido' }).click()
    await expect(page.getByText('Pedido criado')).toBeVisible()

    const card = page.locator('div', { hasText: produto.nome }).filter({ has: page.getByRole('button', { name: 'Em Preparo' }) }).last()
    // Botao de cancelar e um icone (X), sem texto acessivel de nome —
    // localizado pela classe de destaque (text-destructive) dentro do card.
    await card.locator('button.text-destructive').click()

    // `move()` (app/page.js) nao dispara toast de sucesso pra mudanca de
    // status — o sinal real e o card sumir. O kanban so tem colunas para os
    // 4 status ativos (recebido, em_preparo,
    // pronto, concluido) — 'cancelado' nao tem coluna propria, entao o sinal
    // visivel de sucesso e o card SUMIR do fluxo, nao aparecer em algum lugar.
    await expect(page.getByRole('button', { name: new RegExp(produto.nome) })).toHaveCount(0)
  })
})
