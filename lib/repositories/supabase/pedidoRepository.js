import { unwrap, applyFilter } from './_shared.js'

/**
 * Supabase*Repository: equivalente a lib/repositories/mongo/pedidoRepository.js.
 *
 * Diferenca estrutural (ver docs/plans/PHASE-5-REPOSITORIES-AUDIT.md secao 4):
 * `Pedido.itens` e embutido no Mongo, mas e tabela filha (`pedido_itens`) no
 * Postgres. Leitura usa resource embedding do PostgREST
 * (`itens:pedido_itens(*)`) para devolver exatamente a mesma forma que o
 * Mongo sempre entregou; escrita separa `.itens` do payload do pedido e
 * insere as linhas filhas depois do pai. Nenhum calculo de negocio aqui -
 * so persistencia e remontagem de forma.
 */
const SELECT_WITH_ITENS = '*, itens:pedido_itens(*)'

export function createPedidoRepository(supabase) {
  return {
    async list(empresaId, filter = {}) {
      let q = supabase.from('pedidos').select(SELECT_WITH_ITENS).eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('created_at', { ascending: false }))
    },
    /** GET /pedidos: mais recentes primeiro, com limite. */
    async listRecentes(empresaId, filter, limit) {
      let q = supabase.from('pedidos').select(SELECT_WITH_ITENS).eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('created_at', { ascending: false }).limit(limit))
    },
    async findByCliente(empresaId, clienteId) {
      return unwrap(
        await supabase.from('pedidos').select(SELECT_WITH_ITENS).eq('empresa_id', empresaId).eq('cliente_id', clienteId).order('created_at', { ascending: false })
      )
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('pedidos').select(SELECT_WITH_ITENS).eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      const { itens = [], ...pedidoFields } = entity
      const pedido = unwrap(await supabase.from('pedidos').insert(pedidoFields).select().single())
      let itensRows = []
      if (itens.length) {
        const rows = itens.map((it) => ({ ...it, pedido_id: pedido.id, empresa_id: pedido.empresa_id }))
        itensRows = unwrap(await supabase.from('pedido_itens').insert(rows).select())
      }
      return { ...pedido, itens: itensRows }
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('pedidos').update(patch).eq('id', id).eq('empresa_id', empresaId).select(SELECT_WITH_ITENS).maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('pedidos').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    /**
     * Chama a MESMA funcao atomica que a trigger pedidos_set_numero() usa
     * (migration 0009) - nunca ha dois caminhos de numeracao (ver auditoria
     * secao 7).
     */
    async nextNumero(empresaId) {
      return unwrap(await supabase.rpc('next_pedido_numero', { p_empresa_id: empresaId }))
    },
  }
}
