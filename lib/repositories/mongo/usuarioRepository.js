/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createUsuarioRepository(database) {
  const col = database.collection('usuarios')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ created_at: -1 }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    /** Email e unico globalmente (nao por empresa) por decisao de produto existente. */
    findByEmail(email) {
      return col.findOne({ email })
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
