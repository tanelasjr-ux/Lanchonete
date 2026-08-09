/**
 * Mercado Pago Adapter (Checkout API Payments)
 * ---------------------------------------------------------------------------
 * Implementa o contrato PaymentProvider via REST (sem SDK) conforme playbook
 * oficial. Access Token SOMENTE backend. Suporta sandbox/producao pela propria
 * credencial. Pix: POST /v1/payments (payment_method_id=pix) + X-Idempotency-Key.
 * Webhook validado por HMAC (x-signature). Refund com idempotencia.
 *
 * config: { accessToken, webhookSecret, mode: 'sandbox'|'production' }
 */

import crypto from 'crypto'

const API = 'https://api.mercadopago.com'

// Normaliza status do MP para o dominio da plataforma.
function normalizeStatus(s) {
  switch (s) {
    case 'approved': return 'approved'
    case 'pending':
    case 'in_process':
    case 'authorized': return 'pending'
    case 'rejected': return 'rejected'
    case 'cancelled': return 'cancelled'
    case 'refunded':
    case 'charged_back': return 'refunded'
    default: return 'unknown'
  }
}

export function createMercadoPagoProvider(config = {}) {
  const token = config.accessToken
  const secret = config.webhookSecret || ''
  if (!token) throw new Error('Mercado Pago nao configurado (accessToken ausente)')

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
    /** Cria um pagamento Pix. input: { amount, description, payerEmail, externalReference, notificationUrl, idempotencyKey, expiresAt } */
    async createPix(input) {
      const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
      const body = {
        transaction_amount: Number(Number(input.amount).toFixed(2)),
        description: input.description || 'Pagamento',
        payment_method_id: 'pix',
        payer: { email: input.payerEmail || 'cliente@example.com' },
        ...(input.externalReference ? { external_reference: input.externalReference } : {}),
        ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
        ...(input.expiresAt ? { date_of_expiration: new Date(input.expiresAt).toISOString() } : {}),
      }
      const p = await mp('/v1/payments', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      })
      const tx = p?.point_of_interaction?.transaction_data || {}
      return {
        providerPaymentId: String(p.id),
        status: normalizeStatus(p.status),
        qrCode: tx.qr_code || null,
        qrCodeBase64: tx.qr_code_base64 || null,
        ticketUrl: tx.ticket_url || null,
        idempotencyKey,
      }
    },

    async getStatus(id) {
      const p = await mp(`/v1/payments/${encodeURIComponent(id)}`)
      return { status: normalizeStatus(p.status), raw: p.status, amount: p.transaction_amount, externalReference: p.external_reference }
    },

    async refund(id, amount) {
      return mp(`/v1/payments/${encodeURIComponent(id)}/refunds`, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': crypto.randomUUID(), 'X-Render-In-Process-Refunds': 'true' },
        body: JSON.stringify(amount === undefined ? {} : { amount: Number(amount) }),
      })
    },

    /** Valida assinatura do webhook. input: { signature, requestId, dataId } */
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

    parseWebhook({ dataId }) {
      return { providerPaymentId: dataId }
    },
  }
}
