/** Mongo*Repository: ver comentario em categoriaRepository.js. Fonte de verdade append-only (sem delete fisico). */
export function createPagamentoRepository(database) {
  const col = database.collection('pagamentos')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    findByProviderPaymentId(empresaId, provider, providerPaymentId) {
      return col.findOne({ empresa_id: empresaId, provider, provider_payment_id: providerPaymentId })
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
    /** Webhook assinado do Mercado Pago: unico ponto que atualiza por provider_payment_id em vez de id. */
    atualizarStatusPorProviderPaymentId(empresaId, provider, providerPaymentId, status) {
      return col.updateOne(
        { empresa_id: empresaId, provider, provider_payment_id: providerPaymentId },
        { $set: { status, updated_at: new Date() } }
      )
    },
  }
}
