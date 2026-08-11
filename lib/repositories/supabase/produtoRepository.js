import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/produtoRepository.js. */
export function createProdutoRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('produtos').select('*').eq('empresa_id', empresaId).order('created_at', { ascending: false }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('produtos').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('produtos').insert(entity).select().single())
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js) - equivalente
     *  ao insertMany do lado Mongo. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('produtos').insert(entities))
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('produtos').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('produtos').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    async deleteManyByCategoria(empresaId, categoriaId) {
      unwrap(await supabase.from('produtos').delete().eq('categoria_id', categoriaId).eq('empresa_id', empresaId))
    },
  }
}
