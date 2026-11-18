/**
 * Trava de seguranca da suite E2E — roda uma vez antes de qualquer spec.
 *
 * Os specs criam empresas, pedidos, caixas e (no caso do caixa) um admin de
 * plataforma de teste. Isso so pode acontecer contra um MongoDB descartavel.
 *
 * Desde 2026-11-17 o `.env` de desenvolvimento aponta para o Supabase de
 * PRODUCAO (nao ha clientes ainda, decisao do dono), e o `playwright.config.js`
 * reaproveita localmente um servidor que ja esteja no ar
 * (`reuseExistingServer`). Sem esta trava, `yarn test:e2e` com o dev server
 * de pe escreveria lixo de teste direto em producao.
 *
 * Conferimos pelo proprio servidor (`/api/health` -> `database`), nao por
 * variavel de ambiente deste processo: o que importa e o banco que o servidor
 * sob teste esta usando de fato.
 */
module.exports = async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || process.env.BASE_URL || 'http://localhost:3000'
  const resp = await fetch(`${baseURL}/api/health`)
  const health = await resp.json().catch(() => ({}))
  if (health.database !== 'mongo') {
    throw new Error(
      `[e2e] ABORTADO: o servidor em ${baseURL} usa database="${health.database}". ` +
        'A suite E2E so roda contra MongoDB descartavel (DATABASE_PROVIDER=mongo). ' +
        'Pare o dev server ligado ao Supabase e rode com DATABASE_PROVIDER=mongo + MONGO_URL de teste.',
    )
  }
}
