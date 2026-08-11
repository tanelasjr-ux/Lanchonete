import { unwrap, applyFilter } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/usuarioRepository.js. */
export function createUsuarioRepository(supabase) {
  return {
    async list(empresaId, filter = {}) {
      let q = supabase.from('usuarios').select('*').eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('created_at', { ascending: false }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('usuarios').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    /** Email e unico globalmente (nao por empresa) por decisao de produto existente. */
    async findByEmail(email) {
      return unwrap(await supabase.from('usuarios').select('*').eq('email', email).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('usuarios').insert(entity).select().single())
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('usuarios').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('usuarios').delete().eq('id', id).eq('empresa_id', empresaId))
    },
  }
}
