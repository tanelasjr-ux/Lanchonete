/**
 * Mongo*Repository: ver comentario em categoriaRepository.js.
 *
 * Conta (contas a pagar/receber): id/empresa_id/tipo/descricao/categoria/
 * natureza/valor/vencimento/status/pago_em/transacao_id/observacoes/
 * created_at/updated_at. "Atrasada" nunca e gravada — sempre derivada na
 * leitura (lib/contas.js).
 */
export function createContaRepository(database) {
  const col = database.collection('contas')

  function _normalize(doc) {
    if (!doc) return null
    return {
      ...doc,
      vencimento: doc.vencimento instanceof Date ? doc.vencimento.toISOString().slice(0, 10) : doc.vencimento,
      pago_em: doc.pago_em instanceof Date ? doc.pago_em.toISOString() : doc.pago_em,
      created_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at,
      updated_at: doc.updated_at instanceof Date ? doc.updated_at.toISOString() : doc.updated_at,
    }
  }

  return {
    async create(entity) {
      await col.insertOne(entity)
      return _normalize(entity)
    },

    async findById(empresaId, id) {
      const doc = await col.findOne({ id, empresa_id: empresaId })
      return _normalize(doc)
    },

    async list(empresaId) {
      const docs = await col.find({ empresa_id: empresaId }).sort({ vencimento: 1 }).toArray()
      return docs.map(_normalize)
    },

    async update(empresaId, id, patch) {
      const r = await col.updateOne({ id, empresa_id: empresaId }, { $set: patch })
      if (r.matchedCount === 0) {
        throw new Error(`Conta ${id} nao encontrada`)
      }
      const doc = await col.findOne({ id, empresa_id: empresaId })
      return _normalize(doc)
    },
  }
}
