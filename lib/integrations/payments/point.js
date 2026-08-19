/**
 * Mercado Pago Point Adapter (Orders API)
 * ---------------------------------------------------------------------------
 * Cobranca no cartao pela maquininha, sem app instalado na loja: o servidor
 * cria a "order", a maquininha Point acende sozinha com o valor. Usa a
 * Orders API (/v1/orders) — NAO a Payment Intents, que e legado e ja tem
 * guia de migracao publicado pelo proprio Mercado Pago (verificado em
 * 2026-08-19, ver docs/superpowers/specs/2026-08-19-pdv-maquininha-design.md).
 *
 * config: { accessToken, webhookSecret, terminalId, mode: 'sandbox'|'production' }
 * Mesma integracao 'mercadopago' que ja existe para o Pix — accessToken e
 * webhookSecret sao compartilhados (mesma conta, mesma credencial);
 * terminalId e exclusivo do Point.
 *
 * https://www.mercadopago.com.br/developers/en/reference/in-person-payments/point/orders/create-order/post
 */

import crypto from 'crypto'

const API = 'https://api.mercadopago.com'

/** Estados da Order do Mercado Pago -> status interno da plataforma. */
export function normalizeStatus(s) {
  switch (s) {
    case 'processed': return 'approved'
    case 'created':
    case 'at_terminal': return 'pending'
    case 'expired':
    case 'canceled': return 'cancelled'
    case 'refunded': return 'refunded'
    default: return 'unknown'
  }
}

/** Reais com 2 casas, string — a Orders API NUNCA aceita centavos. */
export function formatarValorParaOrder(amount) {
  return Number(amount).toFixed(2)
}

/** Mesmo padrao ja usado no Pix (route.js, POST /comandas/:id/pix). */
export function montarExternalReference(empresaId, tipo, id) {
  return `${empresaId}:${tipo}:${id}`
}

export function createPointProvider(config = {}) {
  const token = config.accessToken
  const terminalId = config.terminalId
  const secret = config.webhookSecret || ''
  if (!token) throw new Error('Mercado Pago nao configurado (accessToken ausente)')
  if (!terminalId) throw new Error('Maquininha nao configurada (terminalId ausente)')

  async function mp(path, init = {}) {
    const res = await fetch(API + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      cache: 'no-store',
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const e = new Error(`Mercado Pago ${res.status}: ${body?.message || JSON.stringify(body)}`)
      e.status = res.status
      throw e
    }
    return body
  }

  return {
    /** Cria a cobranca e acende a maquininha. input: { amount, description, externalReference, idempotencyKey } */
    async createOrder(input) {
      const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
      const body = {
        type: 'point',
        external_reference: input.externalReference,
        expiration_time: 'PT3M',
        transactions: { payments: [{ amount: formatarValorParaOrder(input.amount) }] },
        config: { point: { terminal_id: terminalId, print_on_terminal: 'no_ticket' } },
        description: input.description || 'Pagamento',
      }
      const o = await mp('/v1/orders', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      })
      return { providerPaymentId: String(o.id), status: normalizeStatus(o.status), idempotencyKey }
    },

    async getOrder(id) {
      const o = await mp(`/v1/orders/${encodeURIComponent(id)}`)
      return { status: normalizeStatus(o.status), raw: o.status, externalReference: o.external_reference }
    },

    /** Cancela cobranca pendente — sem isso a maquininha fica travada esperando. */
    async cancelOrder(id) {
      await mp(`/v1/orders/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      })
    },

    /** Mesmo esquema HMAC do webhook de Payments — assinatura e da plataforma MP, nao por topico. */
    verifyWebhook({ signature, requestId, dataId }) {
      if (!secret) return false
      if (!signature || !requestId || !dataId) return false
      const parts = Object.fromEntries(signature.split(',').map((x) => x.split('=').map((s) => s.trim())))
      const ts = parts.ts
      const v1 = parts.v1
      if (!ts || !v1) return false
      const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`
      const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex')
      try {
        return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected))
      } catch {
        return false
      }
    },
  }
}
