/**
 * Mongo*Repository: adaptador fino de persistencia, implementa o contrato
 * CategoriaRepository de packages/domain/src/index.ts. Nao aplica defaults
 * nem regra de negocio - isso continua no chamador (route.js), para manter
 * este refactor sem mudanca de comportamento (Fase 3 da migracao Supabase).
 */
export function createCategoriaRepository(database) {
  const col = database.collection('categorias')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ ordem: 1 }).toArray()
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
  }
}
