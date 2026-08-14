/** Mongo*Repository: ver comentario em categoriaRepository.js. */
export function createProdutoRepository(database) {
  const col = database.collection('produtos')
  return {
    list(empresaId, filter = {}) {
      return col.find({ empresa_id: empresaId, ...filter }).sort({ created_at: -1 }).toArray()
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
    deleteManyByCategoria(empresaId, categoriaId) {
      return col.deleteMany({ categoria_id: categoriaId, empresa_id: empresaId })
    },
    async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
      const atual = await this.findById(empresaId, produtoId)
      if (!atual) throw new Error('Produto nao encontrado')

      if (!atual.estoque_habilitado) {
        return atual
      }

      const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)

      if (novaQuantidade < 0) {
        throw new Error(`Estoque insuficiente: ${atual.nome} (tinha ${atual.estoque_quantidade}, tentou vender ${quantidade})`)
      }

      await col.updateOne(
        { id: produtoId, empresa_id: empresaId },
        {
          $set: {
            estoque_quantidade: Number(novaQuantidade),
            updated_at: new Date(),
          },
        }
      )

      return this.findById(empresaId, produtoId)
    },
    async ajustarEstoque(empresaId, produtoId, novaQuantidade, motivo) {
      const atual = await this.findById(empresaId, produtoId)
      if (!atual) throw new Error('Produto nao encontrado')

      if (novaQuantidade < 0) throw new Error('Quantidade nao pode ser negativa')

      await col.updateOne(
        { id: produtoId, empresa_id: empresaId },
        {
          $set: {
            estoque_quantidade: Number(novaQuantidade),
            updated_at: new Date(),
          },
        }
      )

      return this.findById(empresaId, produtoId)
    },
    async listEstoqueBaixo(empresaId) {
      const docs = await col
        .find({
          empresa_id: empresaId,
          estoque_habilitado: true,
          $expr: { $lte: ['$estoque_quantidade', '$estoque_minimo'] },
        })
        .sort({ estoque_quantidade: 1 })
        .toArray()

      return docs
    },
    async getEstoque(empresaId, produtoId) {
      const p = await this.findById(empresaId, produtoId)
      return p?.estoque_quantidade || null
    },
  }
}
