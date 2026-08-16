import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/produtoRepository.js. */
export function createProdutoRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('produtos').select('*').eq('empresa_id', empresaId).order('created_at', { ascending: false }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('produtos').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('produtos').insert(entity).select().single())
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js) - equivalente
     *  ao insertMany do lado Mongo. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('produtos').insert(entities))
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('produtos').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('produtos').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    async deleteManyByCategoria(empresaId, categoriaId) {
      unwrap(await supabase.from('produtos').delete().eq('categoria_id', categoriaId).eq('empresa_id', empresaId))
    },
    async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
      // Fetch current state
      const atual = await this.findById(empresaId, produtoId)
      if (!atual) throw new Error('Produto nao encontrado')

      // If tracking disabled, no-op
      if (!atual.estoque_habilitado) {
        return atual
      }

      const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)

      // Hard block: cannot go negative
      if (novaQuantidade < 0) {
        throw new Error(`Estoque insuficiente: ${atual.nome} (tinha ${atual.estoque_quantidade}, tentou vender ${quantidade})`)
      }

      // Update in Supabase
      const updated = await unwrap(
        await supabase
          .from('produtos')
          .update({
            estoque_quantidade: novaQuantidade,
            updated_at: new Date().toISOString(),
          })
          .eq('id', produtoId)
          .eq('empresa_id', empresaId)
          .select()
          .maybeSingle()
      )

      if (!updated) throw new Error('Falha ao atualizar estoque')
      return updated
    },
    async ajustarEstoque(empresaId, produtoId, novaQuantidade, motivo) {
      const atual = await this.findById(empresaId, produtoId)
      if (!atual) throw new Error('Produto nao encontrado')

      if (novaQuantidade < 0) throw new Error('Quantidade nao pode ser negativa')

      const updated = await unwrap(
        await supabase
          .from('produtos')
          .update({
            estoque_quantidade: Number(novaQuantidade),
            updated_at: new Date().toISOString(),
          })
          .eq('id', produtoId)
          .eq('empresa_id', empresaId)
          .select()
          .maybeSingle()
      )

      if (!updated) throw new Error('Falha ao atualizar estoque')
      return updated
    },
    async listEstoqueBaixo(empresaId) {
      // A comparacao entre DUAS COLUNAS (quantidade <= minimo) nao existe nos
      // filtros do PostgREST: `.lte('estoque_quantidade', 'estoque_minimo')`
      // compara com a string literal 'estoque_minimo', e o Postgres falha ao
      // converte-la para numeric. Por isso o filtro acontece em memoria, sobre
      // o subconjunto ja reduzido pelo indice parcial
      // idx_produtos_estoque_habilitado.
      const comEstoque = unwrap(await supabase
        .from('produtos')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('estoque_habilitado', true)) || []

      return comEstoque
        .filter((p) => Number(p.estoque_quantidade || 0) <= Number(p.estoque_minimo || 0))
        .sort((a, b) => Number(a.estoque_quantidade || 0) - Number(b.estoque_quantidade || 0))
    },
    async getEstoque(empresaId, produtoId) {
      const p = await this.findById(empresaId, produtoId)
      return p?.estoque_quantidade || null
    },
  }
}
