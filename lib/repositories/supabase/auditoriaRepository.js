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
    /**
     * Logins recentes de TODAS as empresas, sem filtro de tenant — so para
     * o Painel da Plataforma calcular "ultimo acesso" por empresa (reduzido
     * em route.js, primeiro por empresa_id na lista ja ordenada por data;
     * nao ha GROUP BY aqui de proposito, pra nao precisar de uma RPC so
     * pra isso). `limit` generoso porque cada login de cada empresa conta
     * uma linha — poucas centenas de empresas ainda cabem folgado.
     */
    async listLogins(limit = 5000) {
      return unwrap(await supabase.from('auditoria').select('empresa_id, usuario_nome, created_at').eq('acao', 'login').order('created_at', { ascending: false }).limit(limit))
    },
  }
}
