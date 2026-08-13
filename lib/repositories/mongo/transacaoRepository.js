/** Mongo*Repository: ver comentario em categoriaRepository.js. */

function normalize(doc) {
  if (!doc) return null
  return {
    id: doc._id || doc.id,
    empresa_id: doc.empresa_id,
    tipo: doc.tipo,
    categoria: doc.categoria,
    descricao: doc.descricao || '',
    valor: doc.valor || 0,
    pedido_id: doc.pedido_id || null,
    comanda_id: doc.comanda_id || null,
    forma_pagamento: doc.forma_pagamento || '',
    caixa_id: doc.caixa_id || null,
    data: doc.data ? new Date(doc.data).toISOString() : null,
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : null,
  }
}

export function createTransacaoRepository(database) {
  const col = database.collection('transacoes')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).toArray()
    },
    /** GET /financeiro/transacoes: mais recentes primeiro, com limite. */
    listRecentes(empresaId, limit) {
      return col.find({ empresa_id: empresaId }).sort({ data: -1 }).limit(limit).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
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
    async findByCaixa(empresaId, caixaId) {
      const docs = await col.find({ empresa_id: empresaId, caixa_id: caixaId }).toArray()
      return docs.map(normalize)
    },
    async findByPedido(empresaId, pedidoId) {
      const docs = await col.find({ empresa_id: empresaId, pedido_id: pedidoId }).toArray()
      return docs.map(normalize)
    },
  }
}
