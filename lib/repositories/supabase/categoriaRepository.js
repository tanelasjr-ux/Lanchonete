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
    /** Bulk insert usado pelo seed de demonstracao (route.js) - equivalente
     *  ao insertMany do lado Mongo. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('categorias').insert(entities))
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('categorias').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('categorias').delete().eq('id', id).eq('empresa_id', empresaId))
    },
  }
}
