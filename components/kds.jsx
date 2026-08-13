'use client'

/**
 * Paineis do KDS (docs/plans/KDS-DESIGN.md). Tres entradas:
 * - KDSTv: TV via link tokenizado (?kds_tv=...), sem login de usuario.
 * - KDSView: papel COZINHA logado, mesma UI, sempre sem toque (so leitura).
 * - CozinhaPendentes: celular do atendente, sempre com toque.
 *
 * Fetch proprio (nao usa o helper api() de app/page.js) porque a TV nao
 * tem token de usuario no localStorage - o helper injetaria um Bearer
 * inexistente/errado.
 */

import { useState, useEffect, useCallback } from 'react'
import { ChefHat, Clock, CheckCircle2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

const LIMITE_ENVELHECIMENTO_MIN = 20

function minutosDesde(dataIso) {
  return Math.floor((Date.now() - new Date(dataIso).getTime()) / 60000)
}

function Cronometro({ createdAt }) {
  const [min, setMin] = useState(() => minutosDesde(createdAt))
  useEffect(() => {
    const id = setInterval(() => setMin(minutosDesde(createdAt)), 15000)
    return () => clearInterval(id)
  }, [createdAt])
  return <span className="tabular-nums">{min < 1 ? 'agora' : `${min} min`}</span>
}

function ItemCard({ item, tocavel, onConcluir, envelhecido }) {
  const titulo = item.origem === 'pedido' ? `Pedido #${item.numero}` : item.mesa_nome
  const linhas = item.origem === 'pedido' ? item.itens : [{ nome: item.nome, quantidade: item.quantidade, observacao: item.observacao }]
  return (
    <Card
      className={`${envelhecido ? 'opacity-60' : ''} ${tocavel ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''}`}
      onClick={tocavel ? () => onConcluir(item) : undefined}
    >
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-bold text-lg">{titulo}</span>
          <Badge variant="outline" className="flex items-center gap-1"><Clock className="h-3 w-3" /><Cronometro createdAt={item.created_at} /></Badge>
        </div>
        <div className="space-y-1">
          {linhas.map((l, i) => (
            <div key={i} className="text-base">
              <span className="font-medium">{l.quantidade}x</span> {l.nome}
              {l.observacao && <div className="text-sm font-semibold text-destructive">⚠ {l.observacao}</div>}
            </div>
          ))}
        </div>
        {tocavel && <div className="flex items-center gap-1 text-sm text-muted-foreground pt-1"><CheckCircle2 className="h-4 w-4" />Toque para concluir</div>}
      </CardContent>
    </Card>
  )
}

/**
 * @param {object} props
 * @param {() => Promise<{itens: any[], modo: string|null}>} props.fetchPendentes
 * @param {(item: any) => Promise<void>} [props.onConcluir] - se ausente, painel e so leitura.
 * @param {boolean} props.tocavel
 */
function KDSPainel({ fetchPendentes, onConcluir, tocavel }) {
  const [itens, setItens] = useState([])
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    try {
      const data = await fetchPendentes()
      setItens(data.itens || [])
      setErro(null)
    } catch (e) {
      setErro(e.message)
    }
  }, [fetchPendentes])

  useEffect(() => {
    carregar()
    const id = setInterval(carregar, 5000)
    return () => clearInterval(id)
  }, [carregar])

  const concluir = async (item) => {
    setItens((s) => s.filter((i) => i.id !== item.id)) // otimista
    try {
      await onConcluir(item)
    } catch (e) {
      setErro(e.message)
      carregar() // desfaz o otimista buscando o estado real
    }
  }

  if (erro) return <div className="min-h-screen grid place-items-center bg-background text-destructive p-8 text-center">{erro}</div>

  const ativos = itens.filter((i) => minutosDesde(i.created_at) < LIMITE_ENVELHECIMENTO_MIN)
  const envelhecidos = itens.filter((i) => minutosDesde(i.created_at) >= LIMITE_ENVELHECIMENTO_MIN)

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center gap-2 text-2xl font-bold"><ChefHat className="h-7 w-7" />Cozinha</div>
      {ativos.length === 0 && envelhecidos.length === 0 && (
        <div className="text-center text-muted-foreground py-24 text-xl">Nenhum pedido pendente</div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {ativos.map((item) => (
          <ItemCard key={`${item.origem}-${item.id}`} item={item} tocavel={tocavel} onConcluir={concluir} envelhecido={false} />
        ))}
      </div>
      {envelhecidos.length > 0 && (
        <div className="border-t pt-4 space-y-2">
          <div className="text-sm text-muted-foreground">Pendente ha mais de {LIMITE_ENVELHECIMENTO_MIN} min</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {envelhecidos.map((item) => (
              <ItemCard key={`${item.origem}-${item.id}`} item={item} tocavel={tocavel} onConcluir={concluir} envelhecido />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** TV: acesso por token, sem login. */
export function KDSTv({ token }) {
  const fetchPendentes = useCallback(async () => {
    const res = await fetch(`/api/kds/pendentes?tv_token=${encodeURIComponent(token)}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Erro ao carregar')
    return data
  }, [token])

  const [modo, setModo] = useState(null)
  useEffect(() => { fetchPendentes().then((d) => setModo(d.modo)).catch(() => {}) }, [fetchPendentes])

  const concluir = async (item) => {
    const res = await fetch(`/api/kds/concluir?tv_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origem: item.origem, id: item.id, comanda_id: item.comanda_id }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Erro ao concluir') }
  }

  return <KDSPainel fetchPendentes={fetchPendentes} onConcluir={modo === 'toque' ? concluir : undefined} tocavel={modo === 'toque'} />
}

/** Papel COZINHA logado: mesma UI, sempre so leitura (docs/plans/KDS-DESIGN.md §2 item 1/§6). */
export function KDSView({ apiFetch }) {
  const fetchPendentes = useCallback(() => apiFetch('/kds/pendentes'), [apiFetch])
  return <KDSPainel fetchPendentes={fetchPendentes} tocavel={false} />
}

/** Celular do atendente: mesma UI, sempre com toque. */
export function CozinhaPendentes({ apiFetch }) {
  const fetchPendentes = useCallback(() => apiFetch('/kds/pendentes'), [apiFetch])
  const concluir = useCallback((item) => apiFetch('/kds/concluir', { method: 'POST', body: { origem: item.origem, id: item.id, comanda_id: item.comanda_id } }), [apiFetch])
  return <KDSPainel fetchPendentes={fetchPendentes} onConcluir={concluir} tocavel />
}
