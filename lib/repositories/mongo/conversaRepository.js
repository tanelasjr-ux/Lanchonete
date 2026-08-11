/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createConversaRepository(database) {
  const col = database.collection('conversas')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ ultima_mensagem_em: -1 }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    findByContatoNumero(empresaId, contatoNumero) {
      return col.findOne({ empresa_id: empresaId, contato_numero: contatoNumero })
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
    /** Usado no webhook do WhatsApp: nova mensagem numa conversa ja existente. */
    incrementarNaoLidas(empresaId, id, patch) {
      return col.updateOne({ id, empresa_id: empresaId }, { $set: patch, $inc: { nao_lidas: 1 } })
    },
  }
}
