import { unwrap } from './_shared.js'

/**
 * Supabase Repository para Entregador.
 * Entregador é um cadastro simples por empresa (nome, telefone, ativo).
 * Não faz login no sistema. Soft-delete via ativo = false.
 */
export function createEntregadorRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('entregadores').insert(entity).select().single())
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('entregadores').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async listByEmpresa(empresaId, ativo) {
      let q = supabase.from('entregadores').select('*').eq('empresa_id', empresaId)
      if (ativo !== undefined) {
        q = q.eq('ativo', ativo)
      }
      return unwrap(await q.order('nome', { ascending: true }))
    },
    async update(empresaId, id, patch) {
      // Use .single() para garantir que um erro é lançado se não encontrado (404)
      // .maybeSingle() retornaria null, o que não é o comportamento esperado para update
      return unwrap(await supabase.from('entregadores').update(patch).eq('id', id).eq('empresa_id', empresaId).select().single())
    },
    async updateAtivo(empresaId, id, ativo) {
      return this.update(empresaId, id, { ativo })
    },
  }
}
