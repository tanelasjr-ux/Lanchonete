/**
 * Mongo*Repository: ver comentario em categoriaRepository.js.
 *
 * Assinatura (mensalidade do SaaS). `listTodas()` NAO filtra por
 * empresa_id de proposito — e a consulta do Painel da Plataforma. A
 * seguranca disso mora em route.js (checagem de `isPlataformaAdmin`),
 * nunca no repository.
 */
export function createAssinaturaRepository(database) {
  const col = database.collection('assinaturas')

  function _normalize(doc) {
    if (!doc) return null
    return {
      ...doc,
      created_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at,
      updated_at: doc.updated_at instanceof Date ? doc.updated_at.toISOString() : doc.updated_at,
    }
  }

  return {
    async create(entity) {
      await col.insertOne(entity)
      return _normalize(entity)
    },
    async findByEmpresa(empresaId) {
      return _normalize(await col.findOne({ empresa_id: empresaId }))
    },
    async findById(id) {
      return _normalize(await col.findOne({ id }))
    },
    async listTodas() {
      const docs = await col.find({}).sort({ proximo_vencimento: 1 }).toArray()
      return docs.map(_normalize)
    },
    async update(id, patch) {
      const r = await col.updateOne({ id }, { $set: patch })
      if (r.matchedCount === 0) throw new Error(`Assinatura ${id} nao encontrada`)
      return _normalize(await col.findOne({ id }))
    },
  }
}
