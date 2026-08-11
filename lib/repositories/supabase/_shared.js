/**
 * Helper comum aos Supabase*Repository. supabase-js nunca lanca excecao por
 * erro de constraint/FK/CHECK - devolve {data, error}. `unwrap()` converte
 * isso numa excecao JS normal (preservando code/details/hint do Postgres),
 * igual ao comportamento que os Mongo*Repository ja tem (driver do Mongo
 * lanca excecao direto). Nunca mascara erro, nunca inventa dado.
 */
/**
 * Aplica um filtro de igualdade simples (chave/valor) a uma query
 * supabase-js, equivalente ao spread `{ empresa_id: x, ...filter }` usado
 * nos Mongo*Repository (list(empresaId, filter)). So igualdade - nenhum
 * Mongo*Repository usa operadores alem de $eq em `filter`.
 */
export function applyFilter(query, filter = {}) {
  let q = query
  for (const [key, value] of Object.entries(filter)) {
    q = q.eq(key, value)
  }
  return q
}

export function unwrap({ data, error }) {
  if (error) {
    const e = new Error(error.message)
    e.code = error.code
    e.details = error.details
    e.hint = error.hint
    throw e
  }
  return data
}
