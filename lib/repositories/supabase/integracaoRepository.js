import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/integracaoRepository.js. Chave logica e (empresaId, tipo). */
export function createIntegracaoRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('integracoes').select('*').eq('empresa_id', empresaId))
    },
    async findByTipo(empresaId, tipo) {
      return unwrap(await supabase.from('integracoes').select('*').eq('empresa_id', empresaId).eq('tipo', tipo).maybeSingle())
    },
    /**
     * `id`/`created_at`/`updated_at` sao deixados de fora do payload de
     * proposito: `id`/`created_at` tem default no schema (so entram em
     * jogo quando e um INSERT de verdade); `updated_at` e mantido pela
     * trigger mecanica `trg_integracoes_updated` mesmo no caminho de
     * UPDATE do upsert (ON CONFLICT DO UPDATE dispara trigger BEFORE
     * UPDATE normalmente).
     */
    async upsert(empresaId, tipo, patch) {
      return unwrap(
        await supabase
          .from('integracoes')
          .upsert({ empresa_id: empresaId, tipo, ...patch }, { onConflict: 'empresa_id,tipo' })
          .select()
          .single()
      )
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js), que cria as 3
     *  integracoes vazias (evolution/n8n/mercadopago) de uma vez. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('integracoes').insert(entities))
    },
  }
}
