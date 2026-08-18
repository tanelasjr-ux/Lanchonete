/**
 * Teste direto de `lib/integrations/monitoring.js` — modulo puro, dividido
 * exatamente para isto: `montarEnvelope()` nao faz I/O, entao da pra
 * verificar a FORMA da requisicao sem precisar de uma conta real do Sentry.
 *
 * Rodar: node tests/test_monitoring.mjs
 */
import assert from 'node:assert/strict'
import { montarEnvelope, isMonitoringConfigured, capturarErro } from '../lib/integrations/monitoring.js'

let falhas = 0
function teste(nome, fn) {
  try {
    fn()
    console.log(`  ok  ${nome}`)
  } catch (e) {
    falhas++
    console.log(`FALHA  ${nome}`)
    console.log(`       ${e.message}`)
  }
}
async function testeAsync(nome, fn) {
  try {
    await fn()
    console.log(`  ok  ${nome}`)
  } catch (e) {
    falhas++
    console.log(`FALHA  ${nome}`)
    console.log(`       ${e.message}`)
  }
}

const DSN_FALSO = 'https://chavepublica123@o000000.ingest.sentry.io/1234567'

teste('isMonitoringConfigured() e false sem SENTRY_DSN no ambiente', () => {
  delete process.env.SENTRY_DSN
  assert.equal(isMonitoringConfigured(), false)
})

teste('isMonitoringConfigured() e true com SENTRY_DSN presente', () => {
  process.env.SENTRY_DSN = DSN_FALSO
  assert.equal(isMonitoringConfigured(), true)
  delete process.env.SENTRY_DSN
})

teste('montarEnvelope() com DSN valido produz URL de ingestao correta', () => {
  const env = montarEnvelope({ dsn: DSN_FALSO, erro: new Error('falha de teste'), contexto: {} })
  assert.ok(env, 'deveria montar um envelope')
  assert.equal(env.url, 'https://o000000.ingest.sentry.io/api/1234567/envelope/')
})

teste('montarEnvelope() usa a chave publica do DSN no header de autenticacao', () => {
  const env = montarEnvelope({ dsn: DSN_FALSO, erro: 'x', contexto: {} })
  assert.match(env.headers['X-Sentry-Auth'], /sentry_key=chavepublica123/)
})

teste('montarEnvelope() com DSN invalido devolve null, nunca lanca', () => {
  assert.equal(montarEnvelope({ dsn: 'nao-e-uma-url', erro: 'x', contexto: {} }), null)
  assert.equal(montarEnvelope({ dsn: '', erro: 'x', contexto: {} }), null)
  assert.equal(montarEnvelope({ dsn: undefined, erro: 'x', contexto: {} }), null)
})

teste('envelope carrega empresa_id/rota/metodo do contexto, nunca dado do cliente final', () => {
  const env = montarEnvelope({
    dsn: DSN_FALSO,
    erro: new Error('falha'),
    contexto: { empresa_id: 'emp-123', rota: '/pedidos', metodo: 'POST' },
  })
  const linhas = env.body.trim().split('\n')
  const evento = JSON.parse(linhas[2])
  assert.equal(evento.tags.empresa_id, 'emp-123')
  assert.equal(evento.tags.rota, '/pedidos')
  assert.equal(evento.tags.metodo, 'POST')
  // O evento so pode ter os 4 campos que o proprio route.js decide passar —
  // nunca o corpo bruto da requisicao, que poderia carregar nome/telefone/
  // endereco de cliente final.
  assert.deepEqual(Object.keys(evento.tags).sort(), ['empresa_id', 'metodo', 'rota'])
})

teste('mensagem do erro e preservada no evento', () => {
  const env = montarEnvelope({ dsn: DSN_FALSO, erro: new Error('banco fora do ar'), contexto: {} })
  const evento = JSON.parse(env.body.trim().split('\n')[2])
  assert.equal(evento.exception.values[0].value, 'banco fora do ar')
})

await testeAsync('capturarErro() SEM SENTRY_DSN e no-op completo: zero chamada de rede', async () => {
  delete process.env.SENTRY_DSN
  let fetchChamado = false
  const fetchOriginal = global.fetch
  global.fetch = () => { fetchChamado = true; throw new Error('fetch nao deveria ser chamado') }
  try {
    const resultado = await capturarErro(new Error('teste'), { empresa_id: 'x' })
    assert.equal(resultado.skipped, true)
    assert.equal(fetchChamado, false, 'capturarErro() sem DSN nao pode chamar fetch()')
  } finally {
    global.fetch = fetchOriginal
  }
})

await testeAsync('capturarErro() NUNCA lanca, mesmo se o fetch falhar', async () => {
  process.env.SENTRY_DSN = DSN_FALSO
  const fetchOriginal = global.fetch
  global.fetch = () => { throw new Error('rede indisponivel') }
  try {
    const resultado = await capturarErro(new Error('teste'), {})
    assert.equal(resultado.ok, false)
  } finally {
    global.fetch = fetchOriginal
    delete process.env.SENTRY_DSN
  }
})

console.log('')
if (falhas > 0) {
  console.log(`${falhas} teste(s) falharam`)
  process.exit(1)
} else {
  console.log('todos os testes passaram')
  process.exit(0)
}
