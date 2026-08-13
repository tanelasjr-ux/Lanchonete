/**
 * MongoRepository para Movimento de Caixa
 * Registros de entrada/saida no caixa (vendas, dinheiro, ajustes, etc)
 */

function normalize(doc) {
  if (!doc) return null
  return {
    id: doc._id,
    empresa_id: doc.empresa_id,
    caixa_id: doc.caixa_id,
    tipo: doc.tipo,
    valor: doc.valor,
    motivo: doc.motivo || '',
    usuario_id: doc.usuario_id ?? null,
    usuario_nome: doc.usuario_nome || '',
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : null,
  }
}

export function createCaixaMovimentoRepository(db) {
  const col = db.collection('caixa_movimentos')
  return {
    async create(entity) {
      await col.insertOne({
        _id: entity.id,
        empresa_id: entity.empresa_id,
        caixa_id: entity.caixa_id,
        tipo: entity.tipo,
        valor: entity.valor,
        motivo: entity.motivo || '',
        usuario_id: entity.usuario_id || null,
        usuario_nome: entity.usuario_nome || '',
        created_at: entity.created_at ? new Date(entity.created_at) : new Date(),
      })
      return this.findById(entity.empresa_id, entity.id)
    },

    async findById(empresaId, id) {
      return normalize(await col.findOne({ _id: id, empresa_id: empresaId }))
    },

    async listByCaixa(empresaId, caixaId) {
      const docs = await col
        .find({ empresa_id: empresaId, caixa_id: caixaId })
        .sort({ created_at: 1 })
        .toArray()
      return docs.map(normalize)
    },
  }
}
