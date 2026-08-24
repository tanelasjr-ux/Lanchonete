/**
 * Mongo*Repository: ver comentario em categoriaRepository.js. E-mails
 * liberados pelo dono para completar POST /auth/register — infraestrutura
 * da plataforma (ETNA), sem escopo de empresa, mesmo espirito de
 * plataformaAdminRepository.js.
 */
export function createEmailLiberadoRepository(database) {
  const col = database.collection('emails_liberados')
  return {
    async findByEmail(email) {
      return await col.findOne({ email })
    },
    async list() {
      return await col.find({}).sort({ created_at: -1 }).toArray()
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    async marcarUsado(email) {
      await col.updateOne({ email }, { $set: { usado_em: new Date() } })
    },
    async delete(id) {
      await col.deleteOne({ id })
    },
  }
}
