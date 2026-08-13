import { unwrap } from './_shared.js'

/**
 * Supabase Repository para Caixa
 * Sessao de caixa: abertura, fechamento, conferencia de valores
 */
export function createCaixaRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase
        .from('caixas')
        .insert({
          id: entity.id,
          empresa_id: entity.empresa_id,
          status: entity.status || 'aberto',
          aberto_por: entity.aberto_por || null,
          aberto_por_nome: entity.aberto_por_nome || '',
          aberto_em: entity.aberto_em || new Date().toISOString(),
          valor_abertura: entity.valor_abertura || 0,
          created_at: entity.created_at || new Date().toISOString(),
        })
        .select()
        .single())
    },

    async findById(empresaId, id) {
      return unwrap(await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .maybeSingle())
    },

    async findAberto(empresaId) {
      return unwrap(await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('status', 'aberto')
        .maybeSingle())
    },

    async listarFechados(empresaId, limite = 20) {
      return unwrap(await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechado')
        .order('fechado_em', { ascending: false })
        .limit(limite)) || []
    },

    async update(empresaId, id, patch) {
      return unwrap(await supabase
        .from('caixas')
        .update(patch)
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .select()
        .single())
    },
  }
}
