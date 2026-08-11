/**
 * Contrapartida Mongo de lib/repositories/supabase/webhookEventsRepository.js.
 *
 * `webhook_events` e infra tecnica (idempotencia de webhook), nao entidade de
 * dominio - por isso nao tem contrato em domain.ts e ficou fora do
 * Repository<T> na Fase 3, com route.js chamando db.collection() direto.
 * A Fase 7 (switch de provider) precisa que esse acesso tambem seja
 * abstraido, senao o runtime Supabase continuaria dependendo do Mongo so
 * para deduplicar webhook. Este arquivo isola a operacao mantendo
 * exatamente o mesmo comportamento de antes.
 */
export function createWebhookEventsRepository(database) {
  const col = database.collection('webhook_events')
  return {
    /**
     * Upsert idempotente por `eventKey`. `upsertedCount` do Mongo e 1 apenas
     * quando o documento foi de fato criado agora - em uma repeticao do mesmo
     * evento o upsert casa com o documento existente e devolve 0. E assim que
     * "ja processado" e detectado sem um findOne separado antes (mesma
     * semantica do `ignoreDuplicates` + `.select()` vazio do lado Supabase).
     */
    async upsert(empresaId, eventKey, provider) {
      const res = await col.updateOne(
        { eventKey },
        { $setOnInsert: { eventKey, empresa_id: empresaId, provider, received_at: new Date() } },
        { upsert: true }
      )
      return { isNew: res.upsertedCount > 0, row: null }
    },
  }
}
