/**
 * Infra tecnica (token de acesso da TV do KDS), sem contrato em domain.ts -
 * mesmo espirito de webhookEventsRepository.js.
 */
export function createKdsTokenRepository(database) {
  const col = database.collection('kds_tokens')
  return {
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    findByToken(token) {
      return col.findOne({ token })
    },
    listByEmpresa(empresaId) {
      return col.find({ empresa_id: empresaId, revogado_em: null }).sort({ criado_em: -1 }).toArray()
    },
    async revoke(empresaId, id) {
      await col.updateOne({ id, empresa_id: empresaId }, { $set: { revogado_em: new Date() } })
      return col.findOne({ id, empresa_id: empresaId })
    },
  }
}
