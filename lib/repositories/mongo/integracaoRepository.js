import { v4 as uuidv4 } from 'uuid'

/** Mongo*Repository: ver comentario em categoriaRepository.js. Chave logica e (empresaId, tipo). */
export function createIntegracaoRepository(database) {
  const col = database.collection('integracoes')
  return {
    list(empresaId) {
      return col.find({ empresa_id: empresaId }).toArray()
    },
    findByTipo(empresaId, tipo) {
      return col.findOne({ empresa_id: empresaId, tipo })
    },
    async upsert(empresaId, tipo, patch) {
      await col.updateOne(
        { empresa_id: empresaId, tipo },
        { $set: { ...patch, updated_at: new Date() }, $setOnInsert: { id: uuidv4(), empresa_id: empresaId, tipo, created_at: new Date() } },
        { upsert: true }
      )
      return col.findOne({ empresa_id: empresaId, tipo })
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js), que cria as 3
     *  integracoes vazias (evolution/n8n/mercadopago) de uma vez. */
    createMany(entities) {
      return col.insertMany(entities)
    },
  }
}
