import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/auditoriaRepository.js. Append-only. */
export function createAuditoriaRepository(supabase) {
  return {
    async list(empresaId, limit = 200) {
      return unwrap(await supabase.from('auditoria').select('*').eq('empresa_id', empresaId).order('created_at', { ascending: false }).limit(limit))
    },
    async registrar(entry) {
      return unwrap(await supabase.from('auditoria').insert(entry).select().single())
    },
  }
}
