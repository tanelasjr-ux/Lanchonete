/** Mongo*Repository: ver comentario em categoriaRepository.js. Historico de mensalidades pagas. */
export function createAssinaturaPagamentoRepository(database) {
  const col = database.collection('assinatura_pagamentos')

  function _normalize(doc) {
    if (!doc) return null
    return { ...doc, created_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at }
  }

  return {
    async create(entity) {
      await col.insertOne(entity)
      return _normalize(entity)
    },
    async listByEmpresa(empresaId, limite = 24) {
      const docs = await col.find({ empresa_id: empresaId }).sort({ pago_em: -1 }).limit(limite).toArray()
      return docs.map(_normalize)
    },
  }
}
