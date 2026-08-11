import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/pagamentoRepository.js. Append-only. */
export function createPagamentoRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('pagamentos').select('*').eq('empresa_id', empresaId))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('pagamentos').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async findByProviderPaymentId(empresaId, provider, providerPaymentId) {
      return unwrap(
        await supabase.from('pagamentos').select('*').eq('empresa_id', empresaId).eq('provider', provider).eq('provider_payment_id', providerPaymentId).maybeSingle()
      )
    },
    async create(entity) {
      return unwrap(await supabase.from('pagamentos').insert(entity).select().single())
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('pagamentos').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('pagamentos').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    /** Webhook assinado do Mercado Pago: unico ponto que atualiza por provider_payment_id em vez de id. */
    async atualizarStatusPorProviderPaymentId(empresaId, provider, providerPaymentId, status) {
      unwrap(
        await supabase
          .from('pagamentos')
          .update({ status })
          .eq('empresa_id', empresaId)
          .eq('provider', provider)
          .eq('provider_payment_id', providerPaymentId)
      )
    },
  }
}
