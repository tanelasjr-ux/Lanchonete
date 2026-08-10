/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createMesaRepository(database) {
  const col = database.collection('mesas')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ numero: 1 }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
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
    /** Usado pelo reloadComanda(): nunca reabre uma mesa ja liberada ('livre'). */
    syncStatusOcupada(empresaId, mesaId, status) {
      return col.updateOne({ id: mesaId, empresa_id: empresaId, status: { $ne: 'livre' } }, { $set: { status } })
    },
  }
}
