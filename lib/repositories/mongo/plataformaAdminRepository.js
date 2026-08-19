/** Mongo*Repository: ver comentario em categoriaRepository.js. Admins da plataforma (ETNA), identidade por e-mail. */
export function createPlataformaAdminRepository(database) {
  const col = database.collection('plataforma_admins')
  return {
    async findByEmail(email) {
      return await col.findOne({ email, ativo: true })
    },
  }
}
