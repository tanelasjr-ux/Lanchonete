/**
 * Monitoramento de erro em producao (item A3 do PROFISSIONALIZACAO.md).
 * ---------------------------------------------------------------------------
 * Hoje um erro em producao so aparece se o dono reclamar — nao ha Sentry,
 * Datadog nem equivalente. `GET /api/health` so reporta configuracao
 * faltando, nunca erro em execucao.
 *
 * Sem `SENTRY_DSN` configurado, `capturarErro()` e um NO-OP completo: zero
 * chamada de rede, comportamento identico ao que o app ja tinha (so
 * `console.error`). Mesma regra que rege `evolution.js`/`n8n.js` neste
 * projeto — "integracao externa nunca e mockada; sem credencial, avisa ou
 * falha, nunca finge sucesso". Aqui "falhar" seria voltar pro
 * `console.error` que ja existia, entao o fallback e literalmente o
 * comportamento anterior, sem regressao alguma pra quem ainda nao configurou.
 *
 * IMPLEMENTACAO MANUAL do protocolo de ingestao do Sentry (Envelope API), em
 * vez do SDK oficial (`@sentry/nextjs`): o SDK completo traz plugin de
 * webpack, upload de sourcemap e instrumentacao automatica que precisariam
 * de uma conta real pra validar ponta a ponta — risco de quebrar o build em
 * silencio numa sessao sem acesso a conta nenhuma pra testar contra. O
 * protocolo HTTP e publico e estavel (https://develop.sentry.dev/sdk/data-model/envelopes/);
 * dividir em `montarEnvelope()` (puro) + `capturarErro()` (I/O) permite
 * testar a FORMA da requisicao sem precisar enviar de verdade.
 *
 * NUNCA envia dado do cliente final (nome/telefone/endereco de consumidor) —
 * so contexto operacional: empresa_id, rota, metodo, mensagem do erro.
 */

import { v4 as uuidv4 } from 'uuid'

/**
 * DSN do Sentry tem o formato `https://<public_key>@<host>/<project_id>`.
 * Devolve null pra qualquer string que nao siga esse formato — DSN mal
 * colado não pode virar excecao no meio do tratamento de outra excecao.
 */
function parseDsn(dsn) {
  try {
    const url = new URL(dsn)
    const publicKey = url.username
    const projectId = url.pathname.replace(/^\//, '')
    if (!publicKey || !projectId) return null
    return { publicKey, projectId, ingestUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/` }
  } catch {
    return null
  }
}

export function isMonitoringConfigured() {
  return Boolean(process.env.SENTRY_DSN)
}

/**
 * Monta o envelope sem enviar nada — funcao pura, testada isolada. Devolve
 * `null` quando o DSN nao e valido (o chamador trata como "nao configurado").
 *
 * @param {object} p
 * @param {string} p.dsn
 * @param {Error|string} p.erro
 * @param {{empresa_id?: string, rota?: string, metodo?: string}} p.contexto
 */
export function montarEnvelope({ dsn, erro, contexto = {} }) {
  const parsed = parseDsn(dsn)
  if (!parsed) return null

  const eventId = uuidv4().replace(/-/g, '')
  const timestamp = new Date().toISOString()
  const mensagem = String((erro && erro.message) || erro || 'Erro desconhecido')
  const tipo = (erro && erro.name) || 'Error'

  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: timestamp, dsn })
  const itemHeader = JSON.stringify({ type: 'event' })
  const item = JSON.stringify({
    event_id: eventId,
    timestamp,
    platform: 'node',
    level: 'error',
    // So o essencial pra reproduzir o problema. Nenhum campo aqui pode vir
    // do corpo da requisicao (poderia conter nome/telefone/endereco do
    // cliente final) — so metadados operacionais que o proprio route.js
    // ja tem disponivel no ponto de captura.
    exception: { values: [{ type: tipo, value: mensagem }] },
    tags: {
      empresa_id: contexto.empresa_id || 'desconhecida',
      rota: contexto.rota || 'desconhecida',
      metodo: contexto.metodo || 'desconhecido',
    },
  })

  return {
    url: parsed.ingestUrl,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=restaurant-os/1.0, sentry_key=${parsed.publicKey}`,
    },
    body: `${envelopeHeader}\n${itemHeader}\n${item}\n`,
  }
}

/**
 * Envia o erro para o Sentry se configurado. Fire-and-forget: NUNCA lanca —
 * uma falha ao REPORTAR o erro nao pode derrubar a resposta real que o
 * usuario esta esperando. Chamar sempre com `.catch(() => {})` no ponto de
 * uso tambem, como defesa em profundidade (ver route.js).
 *
 * @param {Error|string} erro
 * @param {{empresa_id?: string, rota?: string, metodo?: string}} contexto
 */
export async function capturarErro(erro, contexto = {}) {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return { skipped: true, reason: 'monitoramento nao configurado (SENTRY_DSN ausente)' }

  const envelope = montarEnvelope({ dsn, erro, contexto })
  if (!envelope) return { skipped: true, reason: 'SENTRY_DSN invalido' }

  try {
    const res = await fetch(envelope.url, { method: 'POST', headers: envelope.headers, body: envelope.body })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    // Rede indisponivel, DNS, timeout — o erro ORIGINAL ja foi logado via
    // console.error pelo chamador antes desta funcao ser invocada.
    return { ok: false, error: e.message }
  }
}
