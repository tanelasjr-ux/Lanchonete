import { unwrap } from './_shared.js'

/** Supabase Repository para o historico de mensalidades pagas (assinatura_pagamentos). */
export function createAssinaturaPagamentoRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('assinatura_pagamentos').insert(entity).select().single())
    },
    async listByEmpresa(empresaId, limite = 24) {
      return unwrap(await supabase.from('assinatura_pagamentos').select('*').eq('empresa_id', empresaId).order('pago_em', { ascending: false }).limit(limite))
    },
  }
}
