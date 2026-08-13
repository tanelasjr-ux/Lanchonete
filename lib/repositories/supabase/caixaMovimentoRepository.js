import { unwrap } from './_shared.js'

/**
 * Supabase Repository para Caixa Movimento
 * Registro imutavel de movimentacoes: entrada, saida, conferencia dentro de um caixa
 */
export function createCaixaMovimentoRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase
        .from('caixa_movimentos')
        .insert({
          id: entity.id,
          empresa_id: entity.empresa_id,
          caixa_id: entity.caixa_id,
          tipo: entity.tipo,
          valor: entity.valor,
          motivo: entity.motivo || '',
          usuario_id: entity.usuario_id || null,
          usuario_nome: entity.usuario_nome || '',
          created_at: entity.created_at || new Date().toISOString(),
        })
        .select()
        .single())
    },

    async findById(empresaId, id) {
      return unwrap(await supabase
        .from('caixa_movimentos')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .maybeSingle())
    },

    async listByCaixa(empresaId, caixaId) {
      return unwrap(await supabase
        .from('caixa_movimentos')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('caixa_id', caixaId)
        .order('created_at', { ascending: true })) || []
    },
  }
}
