/**
 * Storage de arquivos (logo da empresa).
 * ============================================================================
 * Usa o Supabase Storage, que e o alvo arquitetural do projeto (CLAUDE.md §4).
 * Fica isolado aqui, como as demais integracoes, para que o Service nao
 * dependa do provedor.
 *
 * Sem credencial configurada, `uploadLogo()` lanca erro explicito — nunca
 * finge sucesso nem grava em outro lugar (mesma regra das integracoes
 * externas: sem configuracao, avisar, jamais simular).
 */

import { getSupabaseAdmin, isSupabaseConfigured } from './supabase'

export const LOGO_BUCKET = 'logos'
export const LOGO_MAX_BYTES = 1024 * 1024 // 1 MB — logo e imagem pequena
export const LOGO_MIME_PERMITIDOS = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']

const EXTENSAO_POR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export function isStorageConfigured() {
  return isSupabaseConfigured()
}

/**
 * Valida e envia a logo de UMA empresa. O caminho e sempre derivado do
 * `empresaId` vindo do token (nunca do corpo da requisicao), entao uma empresa
 * nao consegue sobrescrever o arquivo de outra.
 *
 * @param {string} empresaId
 * @param {Buffer} buffer   conteudo do arquivo
 * @param {string} mimeType
 * @returns {Promise<string>} URL publica da logo
 */
export async function uploadLogo(empresaId, buffer, mimeType) {
  if (!isStorageConfigured()) {
    throw new Error('Storage nao configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.')
  }
  if (!LOGO_MIME_PERMITIDOS.includes(mimeType)) {
    throw new Error(`Formato nao suportado. Use PNG, JPG, WEBP ou SVG.`)
  }
  if (!buffer?.length) throw new Error('Arquivo vazio.')
  if (buffer.length > LOGO_MAX_BYTES) {
    throw new Error(`Arquivo muito grande (${(buffer.length / 1024).toFixed(0)} KB). Limite: 1 MB.`)
  }

  const supabase = await getSupabaseAdmin()
  const ext = EXTENSAO_POR_MIME[mimeType]
  // Nome fixo por empresa + upsert: trocar a logo substitui a anterior em vez
  // de acumular arquivos orfaos no bucket a cada troca.
  const caminho = `${empresaId}/logo.${ext}`

  const { error } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(caminho, buffer, { contentType: mimeType, upsert: true })
  if (error) throw new Error(`Falha ao enviar a logo: ${error.message}`)

  const { data } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(caminho)
  // `?v=` derruba o cache do browser/CDN — sem isso, trocar a logo mantendo o
  // mesmo caminho continuaria exibindo a imagem antiga.
  return `${data.publicUrl}?v=${Date.now()}`
}

/** Remove a logo da empresa (usado ao limpar o campo). Falha silenciosa: se o
 *  arquivo nao existir, nao ha o que apagar e isso nao e um erro. */
export async function removeLogo(empresaId) {
  if (!isStorageConfigured()) return
  const supabase = await getSupabaseAdmin()
  const caminhos = Object.values(EXTENSAO_POR_MIME).map((ext) => `${empresaId}/logo.${ext}`)
  await supabase.storage.from(LOGO_BUCKET).remove(caminhos)
}
