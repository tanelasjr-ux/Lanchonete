import { unwrap, applyFilter } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/conversaRepository.js. */
export function createConversaRepository(supabase) {
  return {
    async list(empresaId, filter = {}) {
      let q = supabase.from('conversas').select('*').eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('ultima_mensagem_em', { ascending: false }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('conversas').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async findByContatoNumero(empresaId, contatoNumero) {
      return unwrap(await supabase.from('conversas').select('*').eq('empresa_id', empresaId).eq('contato_numero', contatoNumero).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('conversas').insert(entity).select().single())
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('conversas').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('conversas').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    /** $set + $inc atomico do Mongo - RPC (ver migration 0009). */
    async incrementarNaoLidas(empresaId, id, patch) {
      unwrap(
        await supabase.rpc('increment_conversa_nao_lidas', {
          p_empresa_id: empresaId,
          p_conversa_id: id,
          p_ultima_mensagem: patch.ultima_mensagem,
          p_ultima_mensagem_em: patch.ultima_mensagem_em,
          p_status: patch.status,
        })
      )
    },
  }
}
