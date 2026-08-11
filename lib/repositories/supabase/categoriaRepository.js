import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/categoriaRepository.js. */
export function createCategoriaRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('categorias').select('*').eq('empresa_id', empresaId).order('ordem', { ascending: true }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('categorias').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('categorias').insert(entity).select().single())
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('categorias').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('categorias').delete().eq('id', id).eq('empresa_id', empresaId))
    },
  }
}
