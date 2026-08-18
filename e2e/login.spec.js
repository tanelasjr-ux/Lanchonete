// @ts-check
const { test, expect } = require('@playwright/test')
const { registrarEmpresa } = require('./helpers')

test.describe('Login', () => {
  test('credenciais corretas entram no painel', async ({ page, request }) => {
    const { email, senha, empresaNome } = await registrarEmpresa(request, 'Login OK')

    await page.goto('/')
    await page.getByPlaceholder('voce@email.com').fill(email)
    await page.getByPlaceholder('••••••••').fill(senha)
    await page.getByRole('button', { name: 'Entrar' }).click()

    // Sidebar com o nome da empresa e o item Dashboard confirmam que passou
    // da tela de auth pro painel de verdade, nao so que o toast apareceu.
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText(empresaNome).first()).toBeVisible()
  })

  test('senha errada mostra erro e mantem na tela de login', async ({ page, request }) => {
    const { email } = await registrarEmpresa(request, 'Login Senha Errada')

    await page.goto('/')
    await page.getByPlaceholder('voce@email.com').fill(email)
    await page.getByPlaceholder('••••••••').fill('senha-completamente-errada')
    await page.getByRole('button', { name: 'Entrar' }).click()

    await expect(page.getByText(/credenciais inv[aá]lidas/i)).toBeVisible()
    // Continua na tela de auth — nao vazou pro painel com sessao invalida.
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible()
  })

  test('recarregar a pagina mantem a sessao (token em localStorage)', async ({ page, request }) => {
    const { email, senha } = await registrarEmpresa(request, 'Login Persistencia')

    await page.goto('/')
    await page.getByPlaceholder('voce@email.com').fill(email)
    await page.getByPlaceholder('••••••••').fill(senha)
    await page.getByRole('button', { name: 'Entrar' }).click()
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible()
  })
})
