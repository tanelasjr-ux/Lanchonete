import { unwrap } from './_shared.js'

/**
 * Supabase Repository para Conta (contas a pagar/receber).
 * `status` e gravado so como 'pendente' | 'paga' | 'cancelada' — "atrasada" e
 * sempre derivado na leitura (lib/contas.js), nunca persistido aqui.
 */
export function createContaRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('contas').insert(entity).select().single())
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('contas').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async list(empresaId) {
      return unwrap(await supabase.from('contas').select('*').eq('empresa_id', empresaId).order('vencimento', { ascending: true }))
    },
    async update(empresaId, id, patch) {
      // .single() em vez de .maybeSingle(): update em id inexistente precisa
      // lancar erro (vira 404 no handler), nao devolver null silenciosamente.
      return unwrap(await supabase.from('contas').update(patch).eq('id', id).eq('empresa_id', empresaId).select().single())
    },
  }
}
