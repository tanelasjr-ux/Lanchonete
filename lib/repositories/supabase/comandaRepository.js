import { unwrap, applyFilter } from './_shared.js'

/**
 * Supabase*Repository: equivalente a lib/repositories/mongo/comandaRepository.js.
 *
 * Duas diferencas estruturais (ver docs/plans/PHASE-5-REPOSITORIES-AUDIT.md
 * secoes 4 e 5), nenhuma delas regra de negocio:
 *
 * 1) `Comanda.itens` e embutido no Mongo, tabela filha (`comanda_itens`) no
 *    Postgres - leitura usa embedding (`itens:comanda_itens(*)`), escrita
 *    separa `.itens` do payload da comanda.
 * 2) `Comanda.pagamentos` (lido por computeComanda() no Service, que nao
 *    pode mudar nesta fase) e um array embutido no Mongo, mas NAO existe
 *    coluna equivalente no Postgres (decisao da Fase 4: `pagamentos` e
 *    tabela propria, fonte unica). A leitura reconstroi esse campo via
 *    embedding a partir da tabela `pagamentos` (so os campos do resumo
 *    antigo); `pushPagamentoResumo()` vira no-op porque o dado ja foi
 *    gravado por PagamentoRepository.create() antes desta chamada.
 */
const SELECT_FULL = '*, itens:comanda_itens(*), pagamentos(id,metodo,valor,status,provider,created_at)'

export function createComandaRepository(supabase) {
  return {
    async list(empresaId, filter = {}) {
      let q = supabase.from('comandas').select(SELECT_FULL).eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('created_at', { ascending: false }).limit(500))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('comandas').select(SELECT_FULL).eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async findManyByIds(empresaId, ids) {
      if (!ids.length) return []
      return unwrap(await supabase.from('comandas').select(SELECT_FULL).eq('empresa_id', empresaId).in('id', ids))
    },
    async create(entity) {
      // `pagamentos` do payload de criacao e sempre [] (mesas/abrir sempre
      // cria com pagamentos:[] no Service) - descartado de proposito, nao
      // existe coluna para ele.
      const { itens = [], pagamentos: _pagamentosIgnorado, ...comandaFields } = entity
      const comanda = unwrap(await supabase.from('comandas').insert(comandaFields).select().single())
      let itensRows = []
      if (itens.length) {
        const rows = itens.map((it) => ({ ...it, comanda_id: comanda.id, empresa_id: comanda.empresa_id }))
        itensRows = unwrap(await supabase.from('comanda_itens').insert(rows).select())
      }
      return { ...comanda, itens: itensRows, pagamentos: [] }
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('comandas').update(patch).eq('id', id).eq('empresa_id', empresaId).select(SELECT_FULL).maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('comandas').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    async pushItem(empresaId, comandaId, item) {
      unwrap(await supabase.from('comanda_itens').insert({ ...item, comanda_id: comandaId, empresa_id: empresaId }))
    },
    async updateItemCampos(empresaId, comandaId, itemId, patch) {
      unwrap(await supabase.from('comanda_itens').update(patch).eq('id', itemId).eq('comanda_id', comandaId).eq('empresa_id', empresaId))
    },
    async removeItem(empresaId, comandaId, itemId) {
      unwrap(await supabase.from('comanda_itens').delete().eq('id', itemId).eq('comanda_id', comandaId).eq('empresa_id', empresaId))
    },
    /** No-op deliberado - ver comentario no topo do arquivo. */
    async pushPagamentoResumo() {},
    async setDerivados(empresaId, comandaId, derivados) {
      unwrap(await supabase.from('comandas').update(derivados).eq('id', comandaId).eq('empresa_id', empresaId))
    },
  }
}
