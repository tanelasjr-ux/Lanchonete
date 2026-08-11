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
    /**
     * Atomico via RPC (migration 0010, correcao preventiva da Fase 5):
     * insere pedido + pedido_itens dentro da MESMA funcao PL/pgSQL - se a
     * insercao dos itens falhar, o pedido tambem e revertido (uma funcao e
     * atomica por natureza). A funcao SQL nao decide nenhum valor de
     * negocio, so persiste o que o Service ja calculou.
     */
    async create(entity) {
      const { itens = [], ...pedidoFields } = entity
      const id = unwrap(await supabase.rpc('create_pedido_com_itens', { p_pedido: pedidoFields, p_itens: itens }))
      return this.findById(pedidoFields.empresa_id, id)
    },
    /**
     * Bulk insert usado pelo seed de demonstracao (route.js) - equivalente ao
     * insertMany do lado Mongo. Como cada pedido do seed ja nasce com itens
     * embutidos, reusa a MESMA RPC atomica do create() por pedido, em vez de
     * um insert em lote na tabela pai: garante a mesma atomicidade
     * pai+filhos e evita duplicar a logica de split de itens.
     */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      for (const entity of entities) {
        const { itens = [], ...pedidoFields } = entity
        unwrap(await supabase.rpc('create_pedido_com_itens', { p_pedido: pedidoFields, p_itens: itens }))
      }
      // Carga em lote traz `numero` ja definido pelo chamador e nao passa
      // pela trigger de numeracao, entao `pedido_contadores` fica para tras
      // e o proximo nextNumero() colidiria com um numero ja gravado
      // (achado real na regressao da Fase 7). Realinhar o contador faz parte
      // de persistir esta carga corretamente - continua mecanico, nao decide
      // valor de negocio. No Mongo nao ha equivalente: la nextNumero() e
      // count()+1, que ja enxerga os pedidos recem-inseridos.
      const empresaId = entities[0].empresa_id
      if (empresaId) unwrap(await supabase.rpc('resync_pedido_contador_empresa', { p_empresa_id: empresaId }))
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
