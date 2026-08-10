/**
 * Mongo*Repository: ver comentario em categoriaRepository.js. Empresa e a
 * raiz do tenant (nao tem empresa_id proprio), por isso nao usa a mesma
 * forma de Repository<T> das entidades escopadas - metodos sao chaveados
 * por `id`/`slug` direto, sem `empresaId` como primeiro parametro.
 */
export function createEmpresaRepository(database) {
  const col = database.collection('empresas')
  return {
    findById(id) {
      return col.findOne({ id })
    },
    findBySlug(slug) {
      return col.findOne({ slug })
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    async update(id, patch) {
      await col.updateOne({ id }, { $set: patch })
      return col.findOne({ id })
    },
  }
}
