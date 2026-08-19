/**
 * Payment Provider Abstraction (Ports & Adapters)
 * ---------------------------------------------------------------------------
 * A aplicacao depende APENAS desta interface, nunca de um gateway especifico.
 * Novos gateways (Asaas, Stripe, etc.) sao adicionados como novos adapters sem
 * alterar Services. Credenciais ficam SOMENTE no backend (config por tenant).
 *
 * Contrato PaymentProvider:
 *   - createPix(input)      -> { providerPaymentId, status, qrCode, qrCodeBase64, ticketUrl }
 *   - getStatus(id)         -> PaymentStatus
 *   - refund(id, amount?)   -> raw
 *   - verifyWebhook(input)  -> boolean
 *   - parseWebhook(input)   -> { providerPaymentId }
 *
 * PaymentStatus normalizado: pending | approved | rejected | cancelled | refunded | unknown
 */

import { createMercadoPagoProvider } from './mercadopago'
import { createPointProvider } from './point'

export const PAYMENT_STATUS = ['pending', 'approved', 'rejected', 'cancelled', 'refunded', 'unknown']

// Metodos de pagamento suportados pela plataforma (habilitados por empresa).
export const PAYMENT_METHODS = {
  dinheiro: { label: 'Dinheiro', online: false },
  pix: { label: 'Pix', online: true },
  cartao_debito: { label: 'Cartao de debito', online: false },
  cartao_credito: { label: 'Cartao de credito', online: false },
}

// Gateways online disponiveis (arquitetura preparada para expansao).
export const PAYMENT_GATEWAYS = {
  mercadopago: { label: 'Mercado Pago', capabilities: ['pix', 'refund', 'webhook'] },
  mercadopago_point: { label: 'Mercado Pago Point (maquininha)', capabilities: ['cartao', 'terminal'] },
  asaas: { label: 'Asaas', capabilities: ['pix'], soon: true },
  stripe: { label: 'Stripe', capabilities: ['card'], soon: true },
}

/**
 * Factory: retorna o adapter do gateway solicitado. Lanca se nao suportado ou
 * nao configurado (nunca retorna implementacao fake).
 */
export function getPaymentProvider(tipo, config = {}) {
  switch (tipo) {
    case 'mercadopago':
      return createMercadoPagoProvider(config)
    case 'mercadopago_point':
      return createPointProvider(config)
    default:
      throw new Error(`Gateway de pagamento nao suportado: ${tipo}`)
  }
}

export function isGatewayConfigured(tipo, config = {}) {
  try {
    if (tipo === 'mercadopago') return Boolean(config?.accessToken)
    if (tipo === 'mercadopago_point') return Boolean(config?.accessToken) && Boolean(config?.terminalId)
    return false
  } catch {
    return false
  }
}
