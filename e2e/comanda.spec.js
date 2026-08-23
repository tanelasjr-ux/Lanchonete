// @ts-check
const { test, expect } = require('@playwright/test')
const { registrarEmpresa, autenticarComo, criarProduto, semearDadosDemo } = require('./helpers')

test.describe('Comanda (mesa)', () => {
  test('abrir mesa, lancar item, pagar dividido em dois metodos, fechar', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'Comanda Fluxo')
    // Empresa nova nasce SEM mesas desde o B2 (ver semearDadosDemo em
    // helpers.js) — sem esta linha nao existe mesa 'Livre' pra clicar.
    await semearDadosDemo(request, token)
    const produto = await criarProduto(request, token, { nome: 'Prato Comanda E2E', preco: 40 })

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Mesas' }).click()

    // `getByRole` e nao `locator('button')`: o card da mesa e uma div com
    // role="button" (botao dentro de botao seria HTML invalido — o botao de
    // renomear vive dentro do card; ver app/page.js).
    const mesaLivre = page.getByRole('button').filter({ hasText: 'Livre' }).first()
    await mesaLivre.click()
    await page.getByRole('button', { name: 'Abrir comanda' }).click()
    await expect(page.getByText('Comanda aberta')).toBeVisible()

    // ComandaDialog abriu — adiciona o item de teste.
    await page.getByRole('button', { name: 'Adicionar item' }).click()
    await page.getByRole('button', { name: new RegExp(produto.nome) }).click()
    await expect(page.getByText(produto.nome)).toBeVisible()

    const cardPagamento = page.locator('div', { hasText: 'Registrar pagamento' }).last()

    // Metade em dinheiro (metodo default).
    await cardPagamento.getByPlaceholder('Valor').fill('20')
    await cardPagamento.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Pagamento registrado')).toBeVisible()

    // Resto em pix — "Preencher restante" busca o valor certo sozinho.
    await cardPagamento.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Pix' }).click()
    await cardPagamento.getByRole('button', { name: 'Preencher restante' }).click()
    await cardPagamento.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Pagamento registrado')).toBeVisible()

    // Restante zerado antes de fechar — senao "Fechar conta" recusaria.
    await expect(page.getByText('R$ 0,00').last()).toBeVisible()

    await page.getByRole('button', { name: 'Fechar conta' }).click()
    await expect(page.getByText(/Comanda fechada/)).toBeVisible()

    // Mesa volta a ficar livre apos o fechamento. `getByRole` pelo mesmo
    // motivo do locator la em cima: o card e div com role="button".
    await expect(page.getByRole('button').filter({ hasText: 'Livre' }).first()).toBeVisible()
  })
})
