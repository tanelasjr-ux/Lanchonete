import { v4 as uuidv4 } from 'uuid'

/** Log imutavel: so create + list, sem update/delete. */
export function createMensagemRepository(database) {
  const col = database.collection('mensagens')
  return {
    list(empresaId, conversaId) {
      return col.find({ empresa_id: empresaId, conversa_id: conversaId }).sort({ created_at: 1 }).limit(500).toArray()
    },
    async create(mensagem) {
      const doc = { id: uuidv4(), created_at: new Date(), ...mensagem }
      await col.insertOne(doc)
      return doc
    },
  }
}
