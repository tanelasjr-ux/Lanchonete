import { unwrap } from './_shared.js'

/**
 * Supabase Repository para emails_liberados — e-mails que o dono da ETNA
 * liberou para completar o cadastro. Sem escopo de empresa (a empresa ainda
 * nem existe quando este registro e consultado), mesmo espirito de
 * plataformaAdminRepository.js.
 */
export function createEmailLiberadoRepository(supabase) {
  return {
    async findByEmail(email) {
      return unwrap(await supabase.from('emails_liberados').select('*').eq('email', email).maybeSingle())
    },
    async list() {
      return unwrap(await supabase.from('emails_liberados').select('*').order('created_at', { ascending: false }))
    },
    async create(entity) {
      return unwrap(await supabase.from('emails_liberados').insert(entity).select().single())
    },
    async marcarUsado(email) {
      unwrap(await supabase.from('emails_liberados').update({ usado_em: new Date() }).eq('email', email))
    },
    async delete(id) {
      unwrap(await supabase.from('emails_liberados').delete().eq('id', id))
    },
  }
}
