import { v4 as uuidv4 } from 'uuid'

/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createAuditoriaRepository(database) {
  const col = database.collection('auditoria')
  return {
    list(empresaId, limit = 200) {
      return col.find({ empresa_id: empresaId }).sort({ created_at: -1 }).limit(limit).toArray()
    },
    async registrar(entry) {
      const doc = { id: uuidv4(), created_at: new Date(), ...entry }
      await col.insertOne(doc)
      return doc
    },
  }
}
