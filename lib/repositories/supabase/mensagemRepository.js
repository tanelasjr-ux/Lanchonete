import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/mensagemRepository.js. Log imutavel: so create + list. */
export function createMensagemRepository(supabase) {
  return {
    async list(empresaId, conversaId) {
      return unwrap(
        await supabase.from('mensagens').select('*').eq('empresa_id', empresaId).eq('conversa_id', conversaId).order('created_at', { ascending: true }).limit(500)
      )
    },
    /** id/created_at tem default no schema - deixados de fora do payload, igual ao padrao dos outros repositories. */
    async create(mensagem) {
      return unwrap(await supabase.from('mensagens').insert(mensagem).select().single())
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js) - equivalente
     *  ao insertMany do lado Mongo. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('mensagens').insert(entities))
    },
  }
}
