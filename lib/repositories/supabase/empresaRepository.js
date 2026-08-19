import { unwrap } from './_shared.js'

/** Supabase*Repository: ver comentario em _shared.js. Equivalente a lib/repositories/mongo/empresaRepository.js. */
export function createEmpresaRepository(supabase) {
  return {
    async findById(id) {
      return unwrap(await supabase.from('empresas').select('*').eq('id', id).maybeSingle())
    },
    async findBySlug(slug) {
      return unwrap(await supabase.from('empresas').select('*').eq('slug', slug).maybeSingle())
    },
    /**
     * TODAS as empresas, sem filtro — unico metodo deste repository que
     * cruza tenants de proposito. So para o Painel da Plataforma
     * (route.js checa `isPlataformaAdmin` antes de chamar).
     */
    async list() {
      return unwrap(await supabase.from('empresas').select('*').order('created_at', { ascending: false }))
    },
    async create(entity) {
      return unwrap(await supabase.from('empresas').insert(entity).select().single())
    },
    async update(id, patch) {
      return unwrap(await supabase.from('empresas').update(patch).eq('id', id).select().maybeSingle())
    },
  }
}
