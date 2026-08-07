/**
 * Supabase Provider (decoupled)
 * ---------------------------------------------------------------------------
 * Camada desacoplada de acesso ao Supabase. A aplicação roda hoje sobre um
 * adaptador MongoDB (RepositoryFactory). Ao preencher as variaveis de ambiente
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY o provider abaixo passa a ficar
 * disponivel, permitindo migrar a persistencia sem refatorar os Services.
 *
 * Nenhum dado e mockado. Sem credenciais, isSupabaseConfigured() => false.
 */

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export function isSupabasePublicConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}

let _admin = null

/**
 * Retorna o client admin (service role) com bypass de RLS para operacoes de
 * servidor. Lazy import para nao exigir a lib quando o provider esta inativo.
 */
export async function getSupabaseAdmin() {
  if (!isSupabaseConfigured()) return null
  if (_admin) return _admin
  const { createClient } = await import('@supabase/supabase-js')
  _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _admin
}

export function supabaseProviderStatus() {
  return {
    configured: isSupabaseConfigured(),
    publicConfigured: isSupabasePublicConfigured(),
    url: process.env.SUPABASE_URL ? '***configured***' : null,
  }
}
