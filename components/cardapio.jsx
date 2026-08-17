'use client'

import { useState, useEffect } from 'react'
import { Search } from 'lucide-react'

export function CardapioPublico({ slug }) {
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)
  const [categoriaAtiva, setCategoriaAtiva] = useState(null)
  const [busca, setBusca] = useState('')

  useEffect(() => {
    fetch(`/api/cardapio/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Cardapio nao encontrado')
        return data
      })
      .then((data) => {
        setDados(data)
        setCategoriaAtiva(data.categorias[0]?.id || null)
      })
      .catch((e) => setErro(e.message))
  }, [slug])

  if (erro) return <div className="min-h-screen grid place-items-center text-center p-8 text-muted-foreground">{erro}</div>
  if (!dados) return <div className="min-h-screen grid place-items-center text-muted-foreground">Carregando...</div>

  const produtosFiltrados = dados.produtos.filter((p) => {
    const naCategoria = !categoriaAtiva || p.categoria_id === categoriaAtiva
    const naBusca = !busca || p.nome.toLowerCase().includes(busca.toLowerCase())
    return naCategoria && naBusca
  })

  const indisponiveisHoje = dados.indisponiveis_hoje || []
  const temImagem = Boolean(dados.empresa.cardapio_imagem_url)

  const BannerIndisponiveis = () => indisponiveisHoje.length === 0 ? null : (
    <div className="mx-4 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
      <span className="font-semibold">Indisponível hoje:</span> {indisponiveisHoje.join(', ')}
    </div>
  )

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background border-b p-4 space-y-3">
        <div className="flex items-center gap-3">
          {dados.empresa.logo && <img src={dados.empresa.logo} alt="" className="h-10 w-10 rounded-full object-cover" />}
          <span className="font-bold text-lg">{dados.empresa.nome}</span>
        </div>
        {!temImagem && (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                className="w-full border rounded-md pl-9 pr-3 py-2 text-sm bg-background"
                placeholder="Buscar produto..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
            {dados.categorias.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {dados.categorias.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setCategoriaAtiva(c.id)}
                    className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap border ${categoriaAtiva === c.id ? 'bg-primary text-primary-foreground border-primary' : 'border-input'}`}
                  >
                    {c.nome}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </header>

      {temImagem ? (
        <main>
          <BannerIndisponiveis />
          {/* Abre em nova aba: da zoom nativo do navegador do celular (pinch),
              sem precisar de biblioteca de lightbox so para isto. */}
          <a href={dados.empresa.cardapio_imagem_url} target="_blank" rel="noopener noreferrer" className="block p-4">
            <img
              src={dados.empresa.cardapio_imagem_url}
              alt={`Cardápio ${dados.empresa.nome}`}
              className="w-full h-auto rounded-lg border"
            />
            <p className="text-center text-xs text-muted-foreground mt-2">Toque na imagem para ampliar</p>
          </a>
        </main>
      ) : (
        <>
          <BannerIndisponiveis />
          <main className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {produtosFiltrados.length === 0 && (
              <div className="col-span-full text-center text-muted-foreground py-16">Nenhum produto encontrado</div>
            )}
            {produtosFiltrados.map((p) => (
              <div key={p.id} className="border rounded-lg overflow-hidden bg-card">
                <div className="aspect-video bg-muted">
                  {p.imagem ? (
                    <img src={p.imagem} alt={p.nome} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-muted-foreground text-sm">Sem foto</div>
                  )}
                </div>
                <div className="p-3 space-y-1">
                  <div className="font-medium">{p.nome}</div>
                  {p.descricao && <div className="text-sm text-muted-foreground line-clamp-2">{p.descricao}</div>}
                  <div className="font-bold text-primary">{p.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</div>
                </div>
              </div>
            ))}
          </main>
        </>
      )}
    </div>
  )
}
