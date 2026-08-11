import { unwrap, applyFilter } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/mesaRepository.js. */
export function createMesaRepository(supabase) {
  return {
    async list(empresaId, filter = {}) {
      let q = supabase.from('mesas').select('*').eq('empresa_id', empresaId)
      q = applyFilter(q, filter)
      return unwrap(await q.order('numero', { ascending: true }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('mesas').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('mesas').insert(entity).select().single())
    },
    async createMany(entities) {
      unwrap(await supabase.from('mesas').insert(entities))
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('mesas').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('mesas').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    /** Usado pelo reloadComanda(): nunca reabre uma mesa ja liberada ('livre'). */
    async syncStatusOcupada(empresaId, mesaId, status) {
      unwrap(await supabase.from('mesas').update({ status }).eq('id', mesaId).eq('empresa_id', empresaId).neq('status', 'livre'))
    },
  }
}
