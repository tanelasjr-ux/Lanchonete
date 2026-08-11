/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createClienteRepository(database) {
  const col = database.collection('clientes')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ created_at: -1 }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    findByTelefone(empresaId, telefone) {
      return col.findOne({ empresa_id: empresaId, telefone })
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
    incrementarMetricasPedido(empresaId, id, valor) {
      return col.updateOne({ id, empresa_id: empresaId }, { $inc: { total_pedidos: 1, total_gasto: valor } })
    },
    count(empresaId) {
      return col.countDocuments({ empresa_id: empresaId })
    },
  }
}
