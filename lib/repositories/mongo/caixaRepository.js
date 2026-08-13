/**
 * MongoRepository para Caixa
 * Sessao de caixa: abertura, fechamento, conferencia de valores
 */

function normalize(doc) {
  if (!doc) return null
  return {
    id: doc._id || doc.id,
    empresa_id: doc.empresa_id,
    status: doc.status,
    aberto_por: doc.aberto_por ?? null,
    aberto_por_nome: doc.aberto_por_nome || '',
    aberto_em: doc.aberto_em ? new Date(doc.aberto_em).toISOString() : null,
    valor_abertura: doc.valor_abertura || 0,
    fechado_por: doc.fechado_por ?? null,
    fechado_por_nome: doc.fechado_por_nome || '',
    fechado_em: doc.fechado_em ? new Date(doc.fechado_em).toISOString() : null,
    valor_contado: doc.valor_contado ?? null,
    valor_esperado: doc.valor_esperado ?? null,
    diferenca: doc.diferenca ?? null,
    observacoes: doc.observacoes || '',
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : null,
  }
}

export function createCaixaRepository(db) {
  const col = db.collection('caixas')
  return {
    async create(entity) {
      await col.insertOne({
        _id: entity.id,
        empresa_id: entity.empresa_id,
        status: entity.status || 'aberto',
        aberto_por: entity.aberto_por || null,
        aberto_por_nome: entity.aberto_por_nome || '',
        aberto_em: entity.aberto_em ? new Date(entity.aberto_em) : new Date(),
        valor_abertura: entity.valor_abertura || 0,
        fechado_por: null,
        fechado_por_nome: '',
        fechado_em: null,
        valor_contado: null,
        valor_esperado: null,
        diferenca: null,
        observacoes: '',
        created_at: entity.created_at ? new Date(entity.created_at) : new Date(),
      })
      return this.findById(entity.empresa_id, entity.id)
    },

    async findById(empresaId, id) {
      return normalize(await col.findOne({ _id: id, empresa_id: empresaId }))
    },

    async findAberto(empresaId) {
      return normalize(await col.findOne({ empresa_id: empresaId, status: 'aberto' }))
    },

    async listarFechados(empresaId, limite = 20) {
      const docs = await col
        .find({ empresa_id: empresaId, status: 'fechado' })
        .sort({ fechado_em: -1 })
        .limit(limite)
        .toArray()
      return docs.map(normalize)
    },

    async update(empresaId, id, patch) {
      const set = { ...patch }
      // Datas chegam como ISO string; o Mongo guarda Date.
      for (const campo of ['fechado_em', 'aberto_em']) {
        if (set[campo]) set[campo] = new Date(set[campo])
      }
      await col.updateOne({ _id: id, empresa_id: empresaId }, { $set: set })
      return this.findById(empresaId, id)
    },
  }
}
