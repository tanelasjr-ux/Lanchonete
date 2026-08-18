// @ts-check
const { defineConfig, devices } = require('@playwright/test')

/**
 * Suite E2E dos fluxos criticos (item A4 do PROFISSIONALIZACAO.md).
 * ---------------------------------------------------------------------------
 * As suites Python (`tests/backend_test_*.py`) cobrem a API. Esta suite cobre
 * a camada onde o operador realmente trabalha — `app/page.js`, 3.900+ linhas,
 * sem NENHUM teste ate esta sessao.
 *
 * `testDir: 'e2e'` — deliberadamente FORA de `tests/`, que e o territorio das
 * suites Python (`tests/run_all.py` so descobre `backend_test_*.py`; nao ha
 * risco de colisao, mas separar os dois sistemas de teste em pastas proprias
 * evita confusao sobre "isso roda com pytest ou com playwright?").
 *
 * `DATABASE_PROVIDER` NUNCA e setado aqui como `supabase` — o projeto nao tem
 * staging separado (ver HANDOFF.md, item C1): rodar teste contra Supabase
 * escreve DIRETO em producao. O `webServer` abaixo sobe sem essa variavel,
 * caindo no default do factory (`mongo`), e o workflow de CI (.github/
 * workflows/e2e.yml) sobe um container MongoDB efemero para isso.
 */
module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false, // fluxos como caixa/comanda mutam estado compartilhado por empresa
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Viewport padrao do Playwright (1280x720) deixa o rodape de dialogos
    // maiores (ex: Novo Pedido) fora da area visivel, exigindo scroll que
    // `.click()` nao faz sozinho em todo caso. 1440x1000 cobre os dialogos
    // usados nesta suite sem precisar de scroll manual em cada teste.
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    // `devices['Desktop Chrome']` embute seu proprio `viewport` (1280x720),
    // que sobrescreveria o `viewport` definido em `use` acima se viesse
    // depois no objeto — por isso o spread vem PRIMEIRO aqui, e o viewport
    // maior (necessario pro rodape de dialogos como Novo Pedido) e reafirmado
    // por ultimo.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    // `dev:no-reload` (nao `dev`): a mesma peculiaridade documentada em
    // package.json (`dev` limita memoria com NODE_OPTIONS, pensado pra
    // ambiente de producao restrito) nao importa aqui, e dev:no-reload
    // sobe mais rapido, o que importa pra CI.
    command: 'npm run dev:no-reload',
    url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/health`,
    // Localmente, reaproveita um servidor que ja esteja no ar (fluxo normal
    // de desenvolvimento desta sessao: o dev server fica de pe entre
    // rodadas). Em CI sempre sobe um novo, garantindo estado limpo.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
