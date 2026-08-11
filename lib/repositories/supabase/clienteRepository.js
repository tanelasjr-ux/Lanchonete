import { unwrap } from './_shared.js'

/** Supabase*Repository: equivalente a lib/repositories/mongo/clienteRepository.js. */
export function createClienteRepository(supabase) {
  return {
    async list(empresaId) {
      return unwrap(await supabase.from('clientes').select('*').eq('empresa_id', empresaId).order('created_at', { ascending: false }))
    },
    async findById(empresaId, id) {
      return unwrap(await supabase.from('clientes').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle())
    },
    async findByTelefone(empresaId, telefone) {
      return unwrap(await supabase.from('clientes').select('*').eq('empresa_id', empresaId).eq('telefone', telefone).maybeSingle())
    },
    async create(entity) {
      return unwrap(await supabase.from('clientes').insert(entity).select().single())
    },
    /** Bulk insert usado pelo seed de demonstracao (route.js) - equivalente
     *  ao insertMany do lado Mongo. */
    async createMany(entities) {
      if (!entities || entities.length === 0) return
      unwrap(await supabase.from('clientes').insert(entities))
    },
    async update(empresaId, id, patch) {
      return unwrap(await supabase.from('clientes').update(patch).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
    async delete(empresaId, id) {
      unwrap(await supabase.from('clientes').delete().eq('id', id).eq('empresa_id', empresaId))
    },
    /** $inc do Mongo nao tem equivalente direto em supabase-js - RPC atomica (ver migration 0009). */
    async incrementarMetricasPedido(empresaId, id, valor) {
      unwrap(await supabase.rpc('increment_cliente_metricas', { p_empresa_id: empresaId, p_cliente_id: id, p_valor: valor }))
    },
    async count(empresaId) {
      const { count, error } = await supabase.from('clientes').select('*', { count: 'exact', head: true }).eq('empresa_id', empresaId)
      if (error) throw error
      return count
    },
  }
}
