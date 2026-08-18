// @ts-check
const { test, expect } = require('@playwright/test')
const { registrarEmpresa, autenticarComo } = require('./helpers')

test.describe('Caixa', () => {
  test('abrir e fechar caixa com conferencia exata', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'Caixa Fluxo')

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Financeiro' }).click()

    await page.getByRole('button', { name: 'Abrir caixa' }).click()
    await page.getByPlaceholder('0,00').fill('100')
    await page.getByRole('button', { name: 'Abrir', exact: true }).click()
    await expect(page.getByText('Caixa aberto', { exact: true })).toBeVisible()

    // Sem vendas no meio, o esperado na gaveta e exatamente o fundo de
    // troco — contar o mesmo valor fecha sem diferenca (sem exigir
    // observacao, que so e obrigatoria quando ha divergencia).
    await page.getByRole('button', { name: /Fechar caixa/ }).click()
    await page.getByPlaceholder('0,00').fill('100')
    await expect(page.getByText('Caixa confere exatamente.')).toBeVisible()
    await page.getByRole('button', { name: 'Confirmar fechamento' }).click()
    await expect(page.getByText('Caixa fechado')).toBeVisible()

    // Volta a mostrar o convite pra abrir um caixa novo.
    await expect(page.getByRole('button', { name: 'Abrir caixa' })).toBeVisible()
  })

  test('fechar caixa com diferenca exige observacao', async ({ page, request }) => {
    const { token } = await registrarEmpresa(request, 'Caixa Diferenca')

    await autenticarComo(page, token)
    await page.getByRole('button', { name: 'Financeiro' }).click()
    await page.getByRole('button', { name: 'Abrir caixa' }).click()
    await page.getByPlaceholder('0,00').fill('100')
    await page.getByRole('button', { name: 'Abrir', exact: true }).click()
    await expect(page.getByText('Caixa aberto', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /Fechar caixa/ }).click()
    await page.getByPlaceholder('0,00').fill('90') // R$10 de falta
    await expect(page.getByText(/Falta de/)).toBeVisible()

    const confirmar = page.getByRole('button', { name: 'Confirmar fechamento' })
    await expect(confirmar).toBeDisabled()

    await page.getByPlaceholder('O que explica a diferença?').fill('Troco a mais dado por engano')
    await expect(confirmar).toBeEnabled()
    await confirmar.click()
    await expect(page.getByText('Caixa fechado')).toBeVisible()
  })
})
