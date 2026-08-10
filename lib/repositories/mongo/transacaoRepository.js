/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createTransacaoRepository(database) {
  const col = database.collection('transacoes')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).toArray()
    },
    /** GET /financeiro/transacoes: mais recentes primeiro, com limite. */
    listRecentes(empresaId, limit) {
      return col.find({ empresa_id: empresaId }).sort({ data: -1 }).limit(limit).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    async update(empresaId, id, patch) {
      await col.updateOne({ id, empresa_id: empresaId }, { $set: patch })
      return col.findOne({ id, empresa_id: empresaId })
    },
    async delete(empresaId, id) {
      await col.deleteOne({ id, empresa_id: empresaId })
    },
  }
}
