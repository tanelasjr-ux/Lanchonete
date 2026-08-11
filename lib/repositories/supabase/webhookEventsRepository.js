/**
 * Nao existe um Mongo*Repository equivalente formal (Fase 3: webhook_events
 * e infra tecnica, nao entidade de dominio - route.js usa
 * db.collection('webhook_events') direto). Este helper isola a mesma
 * operacao de idempotencia do lado Supabase, sem contrato em domain.ts,
 * espelhando a mesma decisao.
 */
export function createWebhookEventsRepository(supabase) {
  return {
    /**
     * Upsert idempotente: INSERT ... ON CONFLICT (event_key) DO NOTHING.
     * Quando ha conflito, nenhuma linha e afetada e `.select()` devolve
     * array vazio - e assim que detectamos "ja processado" sem precisar de
     * um SELECT separado antes (mesmo espirito do upsertedCount do Mongo).
     */
    async upsert(empresaId, eventKey, provider) {
      const { data, error } = await supabase
        .from('webhook_events')
        .upsert({ event_key: eventKey, empresa_id: empresaId, provider }, { onConflict: 'event_key', ignoreDuplicates: true })
        .select()
      if (error) throw error
      return { isNew: data.length > 0, row: data[0] || null }
    },
  }
}
