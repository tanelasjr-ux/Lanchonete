/**
 * n8n Integration Layer (Automations)
 * ---------------------------------------------------------------------------
 * Camada de comunicacao com o n8n (self-hosted) via webhooks. Publica eventos
 * de dominio (order.created, order.status_changed, customer.created, etc.) para
 * um webhook configurado por empresa ou global (N8N_WEBHOOK_URL).
 *
 * Sem webhook configurado, triggerN8nEvent() apenas retorna { skipped: true }.
 * Nenhum dado e mockado.
 */

function resolveConfig(config = {}) {
  return {
    webhookUrl: config.webhookUrl || process.env.N8N_WEBHOOK_URL || '',
    apiKey: config.apiKey || process.env.N8N_API_KEY || '',
  }
}

export function isN8nConfigured(config) {
  return Boolean(resolveConfig(config).webhookUrl)
}

/**
 * Dispara um evento de dominio para o n8n. Nao lanca excecao para nao bloquear
 * o fluxo principal (fire-and-forget resiliente).
 */
export async function triggerN8nEvent(config, event, payload) {
  const cfg = resolveConfig(config)
  if (!cfg.webhookUrl) return { skipped: true, reason: 'n8n nao configurado' }
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {}),
      },
      body: JSON.stringify({ event, payload, timestamp: new Date().toISOString() }),
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** Testa a conectividade do webhook n8n. */
export async function testN8nConnection(config) {
  const cfg = resolveConfig(config)
  if (!cfg.webhookUrl) return { connected: false, message: 'n8n nao configurado' }
  const result = await triggerN8nEvent(cfg, 'connection.test', { ping: true })
  return { connected: Boolean(result.ok), ...result }
}
