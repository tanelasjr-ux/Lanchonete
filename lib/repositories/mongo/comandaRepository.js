/**
 * Mongo*Repository: ver comentario em categoriaRepository.js. Sem logica de
 * negocio - quem decide o que escrever (recalculo via computeComanda(),
 * orquestracao com pedido/transacao/mesa) e o Service em route.js.
 */
export function createComandaRepository(database) {
  const col = database.collection('comandas')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ created_at: -1 }).limit(500).toArray()
    },
    findById(empresaId, id) {
      return col.findOne({ id, empresa_id: empresaId })
    },
    findManyByIds(empresaId, ids) {
      return col.find({ empresa_id: empresaId, id: { $in: ids } }).toArray()
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
    pushItem(empresaId, comandaId, item) {
      return col.updateOne({ id: comandaId, empresa_id: empresaId }, { $push: { itens: item } })
    },
    updateItemCampos(empresaId, comandaId, itemId, patch) {
      const set = {}
      if (patch.quantidade !== undefined) set['itens.$.quantidade'] = patch.quantidade
      if (patch.observacao !== undefined) set['itens.$.observacao'] = patch.observacao
      return col.updateOne({ id: comandaId, empresa_id: empresaId, 'itens.id': itemId }, { $set: set })
    },
    removeItem(empresaId, comandaId, itemId) {
      return col.updateOne({ id: comandaId, empresa_id: empresaId }, { $pull: { itens: { id: itemId } } })
    },
    pushPagamentoResumo(empresaId, comandaId, resumo) {
      return col.updateOne({ id: comandaId, empresa_id: empresaId }, { $push: { pagamentos: resumo } })
    },
    setDerivados(empresaId, comandaId, derivados) {
      return col.updateOne({ id: comandaId, empresa_id: empresaId }, { $set: { ...derivados, updated_at: new Date() } })
    },
  }
}
