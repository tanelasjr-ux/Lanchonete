import { unwrap } from './_shared.js'

/**
 * Supabase Repository para Assinatura (mensalidade do SaaS).
 *
 * DIFERENTE de todo outro repository do projeto: `listTodas()` NAO filtra
 * por empresa_id de proposito — e a consulta do Painel da Plataforma, que
 * precisa enxergar TODAS as empresas. A seguranca disso nao mora aqui; mora
 * em route.js checando `isPlataformaAdmin` antes de chamar este metodo. Os
 * outros metodos (`findByEmpresa`) continuam escopados, para o uso do lado
 * do CLIENTE (checar a propria assinatura).
 */
export function createAssinaturaRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('assinaturas').insert(entity).select().single())
    },
    async findByEmpresa(empresaId) {
      return unwrap(await supabase.from('assinaturas').select('*').eq('empresa_id', empresaId).maybeSingle())
    },
    async findById(id) {
      return unwrap(await supabase.from('assinaturas').select('*').eq('id', id).maybeSingle())
    },
    /** So para o Painel da Plataforma — ver aviso acima. */
    async listTodas() {
      return unwrap(await supabase.from('assinaturas').select('*').order('proximo_vencimento', { ascending: true }))
    },
    async update(id, patch) {
      return unwrap(await supabase.from('assinaturas').update(patch).eq('id', id).select().single())
    },
  }
}
