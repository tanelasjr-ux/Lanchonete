/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createProdutoRepository(database) {
  const col = database.collection('produtos')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ created_at: -1 }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js). Mesmo espirito
     *  do createMany ja existente em mesaRepository - o contrato base
     *  Repository<T> so define create() singular. */
    createMany(entities) {
      return col.insertMany(entities)
    },
    async update(empresaId, id, patch) {
      await col.updateOne({ id, empresa_id: empresaId }, { $set: patch })
      return col.findOne({ id, empresa_id: empresaId })
    },
    async delete(empresaId, id) {
      await col.deleteOne({ id, empresa_id: empresaId })
    },
    deleteManyByCategoria(empresaId, categoriaId) {
      return col.deleteMany({ categoria_id: categoriaId, empresa_id: empresaId })
    },
  }
}
