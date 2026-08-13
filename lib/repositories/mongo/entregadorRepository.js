/**
 * Mongo*Repository: ver comentario em categoriaRepository.js.
 *
 * Entregadores (delivery drivers): entidade com id/empresa_id/nome/telefone/ativo/created_at.
 * Soft-delete only: ativo = false, nunca hard-delete.
 * Normaliza datas MongoDB para ISO strings na retorno.
 */
export function createEntregadorRepository(database) {
  const col = database.collection('entregadores')

  function _normalize(doc) {
    if (!doc) return null
    return {
      ...doc,
      created_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at,
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

    async listByEmpresa(empresaId, ativo) {
      const query = { empresa_id: empresaId }
      if (ativo !== undefined) {
        query.ativo = ativo
      }
      const docs = await col.find(query).sort({ created_at: -1 }).toArray()
      return docs.map(_normalize)
    },

    async update(empresaId, id, patch) {
      await col.updateOne({ id, empresa_id: empresaId }, { $set: patch })
      const doc = await col.findOne({ id, empresa_id: empresaId })
      if (!doc) {
        throw new Error(`Entregador ${id} não encontrado`)
      }
      return _normalize(doc)
    },

    async updateAtivo(empresaId, id, ativo) {
      return this.update(empresaId, id, { ativo })
    },
  }
}
