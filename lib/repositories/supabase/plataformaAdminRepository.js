import { unwrap } from './_shared.js'

/**
 * Supabase Repository para plataforma_admins — quem administra a ETNA, nao
 * um restaurante. Identidade e o E-MAIL (nao usuario_id): um admin nao
 * precisa nem ter usuario num tenant especifico, so precisar logar com um
 * email que bata com esta tabela (ver route.js).
 */
export function createPlataformaAdminRepository(supabase) {
  return {
    async findByEmail(email) {
      return unwrap(await supabase.from('plataforma_admins').select('*').eq('email', email).eq('ativo', true).maybeSingle())
    },
  }
}
