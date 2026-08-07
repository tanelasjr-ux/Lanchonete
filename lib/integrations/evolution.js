/**
 * Evolution API Integration Layer (WhatsApp)
 * ---------------------------------------------------------------------------
 * Camada de comunicacao desacoplada com a Evolution API (self-hosted).
 * Ativada por empresa via configuracao persistida (serverUrl + apiKey +
 * instance) ou por variaveis de ambiente globais como fallback.
 *
 * IMPORTANTE: sem credenciais, as funcoes retornam status "nao configurado".
 * Nenhuma resposta e mockada.
 */

function resolveConfig(config = {}) {
  return {
    serverUrl: config.serverUrl || process.env.EVOLUTION_API_URL || '',
    apiKey: config.apiKey || process.env.EVOLUTION_API_KEY || '',
    instance: config.instance || 'restaurant-os',
  }
}

export function isEvolutionConfigured(config) {
  const c = resolveConfig(config)
  return Boolean(c.serverUrl && c.apiKey)
}

async function evolutionFetch(cfg, path, options = {}) {
  const url = `${cfg.serverUrl.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.apiKey,
      ...(options.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.message || `Evolution API error (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

/** Consulta o estado da instancia (open/close/connecting). */
export async function fetchInstanceStatus(config) {
  const cfg = resolveConfig(config)
  if (!isEvolutionConfigured(cfg)) {
    return { connected: false, state: 'not_configured', message: 'Evolution API nao configurada' }
  }
  try {
    const data = await evolutionFetch(cfg, `/instance/connectionState/${cfg.instance}`, { method: 'GET' })
    const state = data?.instance?.state || data?.state || 'unknown'
    return { connected: state === 'open', state, raw: data }
  } catch (e) {
    return { connected: false, state: 'error', message: e.message }
  }
}

/** Retorna o QR Code / pairing para conectar a instancia. */
export async function connectInstance(config) {
  const cfg = resolveConfig(config)
  if (!isEvolutionConfigured(cfg)) throw new Error('Evolution API nao configurada')
  return evolutionFetch(cfg, `/instance/connect/${cfg.instance}`, { method: 'GET' })
}

/** Envia mensagem de texto via WhatsApp. */
export async function sendWhatsappMessage(config, { to, message }) {
  const cfg = resolveConfig(config)
  if (!isEvolutionConfigured(cfg)) throw new Error('Evolution API nao configurada')
  if (!to || !message) throw new Error('Destinatario e mensagem sao obrigatorios')
  return evolutionFetch(cfg, `/message/sendText/${cfg.instance}`, {
    method: 'POST',
    body: JSON.stringify({ number: to, text: message }),
  })
}
