import { unwrap } from './_shared.js'

/**
 * Contrapartida Mongo de lib/repositories/mongo/kdsTokenRepository.js.
 */
export function createKdsTokenRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('kds_tokens').insert(entity).select().single())
    },
    async findByToken(token) {
      return unwrap(await supabase.from('kds_tokens').select('*').eq('token', token).maybeSingle())
    },
    async listByEmpresa(empresaId) {
      return unwrap(await supabase.from('kds_tokens').select('*').eq('empresa_id', empresaId).order('criado_em', { ascending: false }))
    },
    async revoke(empresaId, id) {
      return unwrap(await supabase.from('kds_tokens').update({ revogado_em: new Date().toISOString() }).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
  }
}
