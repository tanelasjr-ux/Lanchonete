import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/transacaoRepository.js. */
export function createTransacaoRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('transacoes').select('*').eq('empresa_id', empresaId))
    },
    /** GET /financeiro/transacoes: mais recentes primeiro, com limite. */
    async listRecentes(empresaId, limit) {
      return unwrap(await supabase.from('transacoes').select('*').eq('empresa_id', empresaId).order('data', { ascending: false }).limit(limit))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('transacoes').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('transacoes').insert(entity).select().single())
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('transacoes').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('transacoes').delete().eq('id', id).eq('empresa_id', empresaId))
    },
  }
}
