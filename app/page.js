'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTheme } from 'next-themes'
import {
  LayoutDashboard, UtensilsCrossed, Users, ShoppingBag, Wallet, Building2,
  UserCog, ScrollText, Plug, Sun, Moon, LogOut, Plus, Search, Trash2, Pencil,
  ChefHat, TrendingUp, TrendingDown, DollarSign, Package, ArrowUpRight,
  CheckCircle2, Clock, ChefHat as Chef, MoreVertical, X, Loader2, ShieldCheck,
  MessageSquare, Workflow, Menu as MenuIcon,
  Armchair, QrCode, Percent, Split, ArrowRightLeft, Palette, CreditCard, Copy, Minus, UserPlus, CircleDollarSign, Settings, Printer, PackageX, AlertCircle,
  Volume2, VolumeX, AlertTriangle,
} from 'lucide-react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip as RTooltip,
} from 'recharts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { imprimirCupom } from '@/components/cupom'
import { dadosCupomPedido, dadosCupomComanda } from '@/lib/cupom-dados'
import { KDSTv, KDSView, CozinhaPendentes } from '@/components/kds'
import { CardapioPublico } from '@/components/cardapio'
import QRCodeSVG from 'qrcode.react'

/* ============================ API CLIENT ============================ */
const TOKEN_KEY = 'ros_token'
const getToken = () => (typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null)
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Erro na requisição')
  return data
}
const brl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0))
const fmtDate = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * VALIDACAO MANUAL — Cupom com delivery (Task 12)
 *
 * Checklist de validacao end-to-end (fazer manualmente no navegador):
 * - [ ] Criar pedido delivery com cliente+endereco, verificar taxa auto-fill
 * - [ ] Avancar status: recebido > em_preparo > pronto
 * - [ ] Imprimir cupom via cliente, verificar:
 *       * Taxa Entrega aparece na secao VALORES
 *       * Endereco aparece na RODAPE (secao separada)
 *       * Ambos desaparecem se taxa=0 ou tipo!=delivery
 * - [ ] Refresh do navegador, verificar persistencia de todos campos
 * - [ ] Criar pedido balcao, editar tipo para delivery, salvar/reload
 * - [ ] Testar soft-delete entregador, verificar entregador_nome persiste
 * - [ ] Multi-tenant: logon empresa 2, verificar isolamento entregadores
 *
 * Cupom template: lib/cupom-dados.js + components/cupom.jsx
 * Impressao: via window.print() no navegador (nao ha backend printing)
 */

/**
 * Busca os dados da empresa sob demanda para o cupom. `Pedidos`/`Mesas` nao
 * recebem `me.empresa` como prop (cada tela busca so o que usa) — chamar
 * `/empresa` aqui e mais simples do que reestruturar o fluxo de estado do
 * app inteiro so para uma acao pontual de impressao.
 */
async function empresaParaCupom() {
  const e = await api('/empresa')
  return { nome: e.nome_comercial || e.nome, endereco: e.endereco, telefone: e.whatsapp || e.telefone, logo: e.logo }
}
async function imprimirPedido(pedido, via) {
  try { imprimirCupom(dadosCupomPedido(pedido, await empresaParaCupom(), via)) }
  catch (e) { toast.error('Nao foi possivel preparar a impressao: ' + e.message) }
}
async function imprimirComanda(comanda, via) {
  try { imprimirCupom(dadosCupomComanda(comanda, await empresaParaCupom(), via)) }
  catch (e) { toast.error('Nao foi possivel preparar a impressao: ' + e.message) }
}

const STATUS = {
  recebido: { label: 'Recebido', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/20' },
  em_preparo: { label: 'Em Preparo', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/20' },
  pronto: { label: 'Pronto', cls: 'bg-violet-500/15 text-violet-500 border-violet-500/20' },
  concluido: { label: 'Concluído', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20' },
  cancelado: { label: 'Cancelado', cls: 'bg-red-500/15 text-red-500 border-red-500/20' },
}
const FLOW = ['recebido', 'em_preparo', 'pronto', 'concluido']

const MESA_STATUS = {
  livre: { label: 'Livre', dot: 'bg-emerald-500', cls: 'border-emerald-500/30 bg-emerald-500/5', text: 'text-emerald-500' },
  ocupada: { label: 'Ocupada', dot: 'bg-red-500', cls: 'border-red-500/40 bg-red-500/5', text: 'text-red-500' },
  aguardando_pagamento: { label: 'Aguardando pagamento', dot: 'bg-amber-500', cls: 'border-amber-500/40 bg-amber-500/5', text: 'text-amber-500' },
  reservada: { label: 'Reservada', dot: 'bg-blue-500', cls: 'border-blue-500/30 bg-blue-500/5', text: 'text-blue-500' },
}

// Converte HEX -> "H S% L%" para injetar nos tokens CSS (--primary etc.)
function hexToHsl(hex) {
  try {
    let h = hex.replace('#', '')
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let hh = 0, s = 0; const l = (max + min) / 2
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) hh = (g - b) / d + (g < b ? 6 : 0)
      else if (max === g) hh = (b - r) / d + 2
      else hh = (r - g) / d + 4
      hh /= 6
    }
    return `${Math.round(hh * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
  } catch { return null }
}

// Picker de cliente reutilizavel: busca por nome/telefone + criacao inline.
function ClientePicker({ value, onChange }) {
  const [clientes, setClientes] = useState([])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [novo, setNovo] = useState({ nome: '', telefone: '', endereco: '' })
  const load = useCallback(() => api('/clientes').then(setClientes).catch((e) => console.error('Falha ao carregar clientes no picker:', e.message)), [])
  useEffect(() => { load() }, [load])
  const selected = clientes.find((c) => c.id === value)
  const filtered = clientes.filter((c) => c.nome.toLowerCase().includes(q.toLowerCase()) || (c.telefone || '').includes(q)).slice(0, 6)
  const criar = async () => {
    if (!novo.nome) return toast.error('Informe o nome')
    try { const c = await api('/clientes', { method: 'POST', body: novo }); toast.success('Cliente criado'); setClientes((s) => [c, ...s]); onChange(c.id); setCreating(false); setOpen(false); setNovo({ nome: '', telefone: '', endereco: '' }) } catch (e) { toast.error(e.message) }
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs">Cliente</Label>
      {selected && !open ? (
        <div className="flex items-center justify-between rounded-lg border p-2.5">
          <div className="text-sm"><span className="font-medium">{selected.nome}</span>{selected.telefone && <span className="text-muted-foreground"> · {selected.telefone}</span>}</div>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setOpen(true)}>Trocar</Button>
        </div>
      ) : (
        <div className="rounded-lg border p-2 space-y-2">
          {!creating ? (
            <>
              <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8 h-9" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <div className="max-h-40 overflow-auto ros-scroll">
                <button type="button" onClick={() => { onChange(null); setOpen(false) }} className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm text-muted-foreground">Sem cliente (Consumidor)</button>
                {filtered.map((c) => (
                  <button type="button" key={c.id} onClick={() => { onChange(c.id); setOpen(false) }} className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm">{c.nome}<span className="text-muted-foreground text-xs"> {c.telefone}</span></button>
                ))}
              </div>
              <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setCreating(true)}><UserPlus className="h-4 w-4 mr-1" />Novo cliente</Button>
            </>
          ) : (
            <div className="space-y-2">
              <Input className="h-9" placeholder="Nome*" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
              <Input className="h-9" placeholder="Telefone / WhatsApp" value={novo.telefone} onChange={(e) => setNovo({ ...novo, telefone: e.target.value })} />
              <Input className="h-9" placeholder="Endereco" value={novo.endereco} onChange={(e) => setNovo({ ...novo, endereco: e.target.value })} />
              <div className="flex gap-2"><Button type="button" size="sm" onClick={criar}>Salvar</Button><Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancelar</Button></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ============================ AUTH SCREEN ============================ */
function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login')
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ empresa_nome: '', nome: '', email: '', senha: '' })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register'
      const payload = mode === 'login' ? { email: form.email, senha: form.senha } : form
      const data = await api(path, { method: 'POST', body: payload })
      localStorage.setItem(TOKEN_KEY, data.token)
      toast.success(mode === 'login' ? 'Bem-vindo de volta!' : 'Empresa criada com sucesso!')
      onAuth()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Brand side */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 bg-gradient-to-br from-primary/90 via-primary to-violet-700 text-primary-foreground overflow-hidden">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, white 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
        <div className="relative flex items-center gap-2 font-semibold text-lg">
          <div className="h-9 w-9 rounded-lg bg-white/15 grid place-items-center"><ChefHat className="h-5 w-5" /></div>
          Restaurant OS
        </div>
        <div className="relative space-y-6">
          <h1 className="text-4xl font-bold leading-tight">A plataforma definitiva para gestão de restaurantes.</h1>
          <p className="text-primary-foreground/80 text-lg">Cardápio, pedidos, clientes, financeiro e integrações WhatsApp — tudo em uma arquitetura multi-tenant pronta para escalar.</p>
          <div className="flex gap-6 pt-4">
            {[['Multi-tenant', 'Isolamento por empresa'], ['Tempo real', 'Pedidos & dashboard'], ['Integrado', 'WhatsApp & n8n']].map(([t, s]) => (
              <div key={t}><div className="font-semibold">{t}</div><div className="text-sm text-primary-foreground/70">{s}</div></div>
            ))}
          </div>
        </div>
        <div className="relative text-sm text-primary-foreground/60">© {new Date().getFullYear()} Restaurant OS · Enterprise SaaS</div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md space-y-8">
          <div className="lg:hidden flex items-center gap-2 font-semibold text-lg">
            <div className="h-9 w-9 rounded-lg bg-primary grid place-items-center text-primary-foreground"><ChefHat className="h-5 w-5" /></div>
            Restaurant OS
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold">{mode === 'login' ? 'Entrar na sua conta' : 'Criar sua empresa'}</h2>
            <p className="text-muted-foreground text-sm">{mode === 'login' ? 'Acesse o painel de gestão do seu restaurante.' : 'Comece agora — sua conta já vem com dados de demonstração.'}</p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div className="space-y-2"><Label>Nome do restaurante</Label><Input placeholder="Ex: Cantina Bella" value={form.empresa_nome} onChange={set('empresa_nome')} required /></div>
                <div className="space-y-2"><Label>Seu nome</Label><Input placeholder="Nome completo" value={form.nome} onChange={set('nome')} required /></div>
              </>
            )}
            <div className="space-y-2"><Label>E-mail</Label><Input type="email" placeholder="voce@email.com" value={form.email} onChange={set('email')} required /></div>
            <div className="space-y-2"><Label>Senha</Label><Input type="password" placeholder="••••••••" value={form.senha} onChange={set('senha')} required /></div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {mode === 'login' ? 'Entrar' : 'Criar empresa'}
            </Button>
          </form>
          <p className="text-sm text-center text-muted-foreground">
            {mode === 'login' ? 'Não tem conta?' : 'Já possui conta?'}{' '}
            <button className="text-primary font-medium hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Cadastre sua empresa' : 'Fazer login'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}

/* ============================ SHARED UI ============================ */
function PageHeader({ title, description, action }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm mt-1">{description}</p>}
      </div>
      {action}
    </div>
  )
}
function Stat({ icon: Icon, label, value, hint, tone = 'primary' }) {
  const tones = { primary: 'text-primary bg-primary/10', emerald: 'text-emerald-500 bg-emerald-500/10', amber: 'text-amber-500 bg-amber-500/10', violet: 'text-violet-500 bg-violet-500/10' }
  return (
    <Card>
      <CardContent className="p-5 flex items-center gap-4">
        <div className={`h-11 w-11 rounded-lg grid place-items-center ${tones[tone]}`}><Icon className="h-5 w-5" /></div>
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold truncate">{value}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
      </CardContent>
    </Card>
  )
}
function Empty({ children }) {
  return <div className="text-center text-muted-foreground py-12 text-sm">{children}</div>
}

/* ============================ ESTOQUE BAIXO CARD ============================ */
function EstoqueBaixoCard() {
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const carregar = async () => {
      try {
        const data = await api('/produtos/estoque-baixo')
        setProdutos(data.produtos || [])
      } catch (e) {
        // Degrade de proposito: card de dashboard com polling de 30s, um
        // toast a cada falha seria ruido continuo. console.warn garante que
        // a falha fica visivel no devtools em vez de indistinguivel de
        // "sem produtos em falta".
        console.warn('Erro ao carregar estoque baixo:', e.message)
        setProdutos([])
      } finally {
        setLoading(false)
      }
    }
    carregar()
    const id = setInterval(carregar, 30000) // Refresh every 30s
    return () => clearInterval(id)
  }, [])

  if (loading) return <Card><CardContent className="p-4">Carregando...</CardContent></Card>
  if (produtos.length === 0) return null // Don't show if no low-stock items

  return (
    <Card className="border-yellow-500 bg-yellow-50">
      <CardHeader>
        <CardTitle className="text-yellow-900 flex items-center gap-2">
          <AlertCircle className="h-5 w-5" />
          Estoque Baixo ({produtos.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {produtos.map(p => (
            <div key={p.id} className="text-sm text-yellow-800">
              <span className="font-medium">{p.nome}</span>: {p.estoque_quantidade} un (mín: {p.estoque_minimo})
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

const ALERTA_ESTOQUE_MUDO_KEY = 'ros_alerta_estoque_mudo'

/**
 * Bipe de alerta gerado em runtime (Web Audio), sem arquivo de som.
 *
 * Um .mp3 exigiria pasta public/ — que este projeto nao tem (ver Dockerfile) —
 * e entraria no bundle. Dois tons curtos e descendentes cortam melhor o ruido
 * de cozinha do que um bipe unico, e nao soam como notificacao de celular.
 */
function tocarBipeAlerta() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const agora = ctx.currentTime
    ;[[880, 0], [660, 0.18]].forEach(([hz, atraso]) => {
      const osc = ctx.createOscillator()
      const vol = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = hz
      // Envelope curto: sem o fade o corte seco vira um "clique" desagradavel.
      vol.gain.setValueAtTime(0.0001, agora + atraso)
      vol.gain.exponentialRampToValueAtTime(0.25, agora + atraso + 0.01)
      vol.gain.exponentialRampToValueAtTime(0.0001, agora + atraso + 0.15)
      osc.connect(vol).connect(ctx.destination)
      osc.start(agora + atraso)
      osc.stop(agora + atraso + 0.16)
    })
    setTimeout(() => ctx.close().catch(() => {}), 800)
  } catch {
    // Navegador bloqueia audio antes da primeira interacao do usuario. O popup
    // continua aparecendo — o som e reforco, nao o canal principal do aviso.
  }
}

/**
 * Alerta global de estoque no minimo ou abaixo dele.
 *
 * Fica no shell da aplicacao, nao no Dashboard: quem esta lancando pedido
 * precisa saber que acabou o item AGORA, e nao na proxima vez que abrir o
 * Dashboard. O card do Dashboard continua existindo como painel de consulta.
 *
 * So dispara em item que ACABOU de entrar em falta — a cada 30s reabrir o mesmo
 * popup dos mesmos itens viraria ruido e o operador aprenderia a ignorar. Item
 * que se recupera sai da lista e volta a poder alertar se cair de novo.
 */
function AlertaEstoqueGlobal({ ativo = true }) {
  const [baixos, setBaixos] = useState([])
  const [novos, setNovos] = useState([])
  const [aberto, setAberto] = useState(false)
  const [mudo, setMudo] = useState(false)
  const conhecidos = useRef(null)

  // Lido depois da montagem: localStorage nao existe no render do servidor.
  useEffect(() => {
    setMudo(localStorage.getItem(ALERTA_ESTOQUE_MUDO_KEY) === '1')
  }, [])

  const alternarMudo = () => {
    setMudo((m) => {
      const proximo = !m
      localStorage.setItem(ALERTA_ESTOQUE_MUDO_KEY, proximo ? '1' : '0')
      return proximo
    })
  }

  useEffect(() => {
    // Empresa sem o modulo de Estoque nao faz o polling de 30s. O backend ja
    // devolve lista vazia nesse caso; parar aqui evita a chamada inutil.
    if (!ativo) return
    let vivo = true
    const verificar = async () => {
      let lista
      try {
        const data = await api('/produtos/estoque-baixo')
        lista = data.produtos || []
      } catch (e) {
        // Polling de 30s: toast a cada falha seria ruido continuo. Ver A2.
        console.warn('Alerta de estoque: falha ao consultar', e.message)
        return
      }
      if (!vivo) return
      setBaixos(lista)

      const idsAgora = new Set(lista.map((p) => p.id))
      // Primeira passada: tudo que ja esta em falta conta como novidade — quem
      // abriu o sistema ainda nao viu esses itens hoje.
      const anteriores = conhecidos.current
      const entraram = anteriores === null
        ? lista
        : lista.filter((p) => !anteriores.has(p.id))
      conhecidos.current = idsAgora

      if (entraram.length > 0) {
        setNovos(entraram)
        setAberto(true)
        if (localStorage.getItem(ALERTA_ESTOQUE_MUDO_KEY) !== '1') tocarBipeAlerta()
      }
    }
    verificar()
    const id = setInterval(verificar, 30000)
    return () => { vivo = false; clearInterval(id) }
  }, [ativo])

  if (!aberto) return null
  const destacar = new Set(novos.map((p) => p.id))

  return (
    <Dialog open onOpenChange={() => setAberto(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-5 w-5" />
            {novos.length === 1 ? 'Item chegou ao estoque mínimo' : `${novos.length} itens chegaram ao estoque mínimo`}
          </DialogTitle>
          <DialogDescription>
            Estes produtos estão na quantidade mínima configurada, ou abaixo dela.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-auto ros-scroll space-y-2">
          {baixos.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between rounded-lg border p-2.5 text-sm ${destacar.has(p.id) ? 'border-amber-500/50 bg-amber-500/10' : ''}`}
            >
              <span className="font-medium">{p.nome}</span>
              <span className="text-muted-foreground">
                {p.estoque_quantidade} <span className="text-xs">(mín. {p.estoque_minimo})</span>
              </span>
            </div>
          ))}
        </div>
        <DialogFooter className="sm:justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={alternarMudo} className="gap-2">
            {mudo ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            {mudo ? 'Som desativado' : 'Som ativado'}
          </Button>
          <Button onClick={() => setAberto(false)}>Entendi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Lucro bruto e CMV do dia.
 *
 * A cobertura aparece junto do numero, nao em nota de rodape: um CMV de 31% com
 * 40% de cobertura nao e um CMV de 31%, e quem olha precisa ver as duas coisas
 * no mesmo instante.
 */
function CmvCards({ cmv }) {
  // `cmv_percent` nulo = nenhum produto vendido tinha custo cadastrado. Estado
  // vazio explicativo em vez de "—": e a unica chance de apresentar a feature a
  // quem nunca a viu.
  if (!cmv || cmv.cmv_percent === null) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Cadastre o custo dos produtos no Cardápio para acompanhar sua margem e o CMV.
        </CardContent>
      </Card>
    )
  }
  const cobertura = cmv.cobertura_percent ?? 0
  const tomCobertura = cobertura < 50 ? 'text-red-600' : cobertura < 80 ? 'text-amber-600' : 'text-emerald-600'
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Stat
        icon={TrendingUp}
        label="Lucro bruto hoje"
        value={brl(cmv.lucro_bruto)}
        hint={`sobre ${brl(cmv.receita_com_custo)} com custo apurado`}
        tone="emerald"
      />
      <Card>
        <CardContent className="space-y-1 p-4">
          <div className="text-sm text-muted-foreground">CMV</div>
          <div className="text-2xl font-semibold">
            {cmv.cmv_percent.toFixed(1).replace('.', ',')}%
          </div>
          <div className="text-xs text-muted-foreground">referência do setor: 28–35%</div>
          <div className={`text-xs font-medium ${tomCobertura}`}>
            cobertura: {cobertura.toFixed(0)}%{cobertura < 80 ? ' ⚠' : ''}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================ DASHBOARD ============================ */
function Dashboard({ temMod = () => true }) {
  const [m, setM] = useState(null)
  useEffect(() => { api('/dashboard/metrics').then(setM).catch((e) => toast.error(e.message)) }, [])
  if (!m) return <Empty>Carregando métricas…</Empty>
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="Visão geral da operação de hoje e dos últimos 7 dias." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={DollarSign} label="Faturamento hoje" value={brl(m.faturamentoHoje)} tone="emerald" />
        <Stat icon={ShoppingBag} label="Pedidos hoje" value={m.pedidosHoje} tone="primary" />
        <Stat icon={TrendingUp} label="Ticket médio" value={brl(m.ticketMedio)} tone="violet" />
        <Stat icon={Users} label="Clientes" value={m.totalClientes} hint={`${m.totalProdutos} produtos no cardápio`} tone="amber" />
      </div>
      <CmvCards cmv={m.cmv} />
      {temMod('estoque') && <EstoqueBaixoCard />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Faturamento — últimos 7 dias</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={m.serie} margin={{ left: -18, right: 8, top: 8 }}>
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} /><stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="dia" tickLine={false} axisLine={false} fontSize={12} stroke="hsl(var(--muted-foreground))" />
                <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="hsl(var(--muted-foreground))" />
                <RTooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} formatter={(v) => brl(v)} />
                <Area type="monotone" dataKey="faturamento" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Top produtos</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(m.topProdutos || []).length === 0 && <Empty>Sem dados</Empty>}
            {(m.topProdutos || []).map((p, i) => (
              <div key={p.nome} className="flex items-center gap-3">
                <div className="h-7 w-7 rounded-md bg-muted grid place-items-center text-xs font-semibold">{i + 1}</div>
                <div className="flex-1 text-sm truncate">{p.nome}</div>
                <Badge variant="secondary">{p.qtd}x</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Pedidos recentes</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Cliente</TableHead><TableHead>Itens</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Data</TableHead></TableRow></TableHeader>
            <TableBody>
              {(m.recentes || []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">#{p.numero}</TableCell>
                  <TableCell>{p.cliente_nome}</TableCell>
                  <TableCell className="text-muted-foreground">{(p.itens || []).length} item(ns)</TableCell>
                  <TableCell><Badge variant="outline" className={STATUS[p.status]?.cls}>{STATUS[p.status]?.label}</Badge></TableCell>
                  <TableCell className="text-right font-medium">{brl(p.total)}</TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">{fmtDate(p.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================ CARDÁPIO ============================ */
function Cardapio() {
  const [cats, setCats] = useState([])
  const [prods, setProds] = useState([])
  const [tab, setTab] = useState('all')
  const [dlg, setDlg] = useState(null) // produto edit
  const [catDlg, setCatDlg] = useState(false)
  const [catName, setCatName] = useState('')
  const [ajusteDlg, setAjusteDlg] = useState(null) // { id, nome, estoque_quantidade }
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api('/categorias'), api('/produtos')])
    setCats(c); setProds(p)
  }, [])
  useEffect(() => { load().catch((e) => toast.error(e.message)) }, [load])

  const saveProd = async (data) => {
    try {
      const payload = {
        ...data,
        custo: data.custo === '' || data.custo === null || data.custo === undefined
          ? null
          : Number(data.custo),
      }
      if (payload.id) await api(`/produtos/${payload.id}`, { method: 'PUT', body: payload })
      else await api('/produtos', { method: 'POST', body: payload })
      toast.success('Produto salvo'); setDlg(null); load()
    } catch (e) { toast.error(e.message) }
  }
  const delProd = async (id) => { try { await api(`/produtos/${id}`, { method: 'DELETE' }); toast.success('Produto removido'); load() } catch (e) { toast.error(e.message) } }
  const toggleDisponivel = async (p) => {
    try {
      const disponivel = !(p.disponivel !== false)
      await api(`/produtos/${p.id}`, { method: 'PUT', body: { disponivel } })
      toast.success(disponivel ? 'Produto marcado como disponível' : 'Produto marcado como em falta')
      load()
    } catch (e) { toast.error(e.message) }
  }
  const handleAjustarEstoque = async (data) => {
    try {
      await api(`/produtos/${data.produto_id}`, {
        method: 'PUT',
        body: { estoque_quantidade: data.quantidade_nova },
      })
      toast.success('Estoque ajustado')
      setAjusteDlg(null)
      load()
    } catch (e) { toast.error(e.message) }
  }
  const addCat = async () => { if (!catName) return; try { await api('/categorias', { method: 'POST', body: { nome: catName } }); setCatName(''); setCatDlg(false); toast.success('Categoria criada'); load() } catch (e) { toast.error(e.message) } }
  const catName_ = (id) => cats.find((c) => c.id === id)?.nome || '—'
  const filtered = tab === 'all' ? prods : prods.filter((p) => p.categoria_id === tab)

  return (
    <div className="space-y-6">
      <PageHeader title="Cardápio" description="Gerencie categorias e produtos do seu restaurante."
        action={<div className="flex gap-2"><Button variant="outline" onClick={() => setCatDlg(true)}><Plus className="h-4 w-4 mr-1" />Categoria</Button><Button onClick={() => setDlg({ nome: '', preco: '', categoria_id: cats[0]?.id, descricao: '', disponivel: true })}><Plus className="h-4 w-4 mr-1" />Produto</Button></div>} />
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant={tab === 'all' ? 'default' : 'outline'} onClick={() => setTab('all')}>Todos ({prods.length})</Button>
        {cats.map((c) => <Button key={c.id} size="sm" variant={tab === c.id ? 'default' : 'outline'} onClick={() => setTab(c.id)}>{c.nome}</Button>)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((p) => (
          <Card key={p.id} className="group">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div><div className="font-semibold">{p.nome}</div><div className="text-xs text-muted-foreground">{catName_(p.categoria_id)}</div></div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 opacity-60 group-hover:opacity-100"><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDlg(p)}><Pencil className="h-4 w-4 mr-2" />Editar</DropdownMenuItem>
                    {p.estoque_habilitado && (
                      <DropdownMenuItem onClick={() => setAjusteDlg({ id: p.id, nome: p.nome, estoque_quantidade: p.estoque_quantidade })}><Package className="h-4 w-4 mr-2" />Ajustar Estoque</DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => toggleDisponivel(p)}><PackageX className="h-4 w-4 mr-2" />{p.disponivel !== false ? 'Marcar como em falta' : 'Marcar como disponível'}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={() => delProd(p.id)}><Trash2 className="h-4 w-4 mr-2" />Remover</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {p.descricao && <p className="text-sm text-muted-foreground line-clamp-2">{p.descricao}</p>}
              <div className="flex items-center justify-between pt-1">
                <span className="font-bold text-lg">{brl(p.preco)}</span>
                <Badge variant="outline" className={p.disponivel !== false ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/10' : 'text-amber-500 border-amber-500/20 bg-amber-500/10'}>{p.disponivel !== false ? 'Disponível' : 'Em falta'}</Badge>
              </div>
              {p.estoque_habilitado && (
                <Badge variant={
                  p.estoque_quantidade == null || p.estoque_quantidade >= p.estoque_minimo ? 'default' :
                  p.estoque_quantidade > 0 ? 'secondary' :
                  'destructive'
                }>
                  {p.estoque_quantidade != null ? `${p.estoque_quantidade.toFixed(2)}` : '—'} un
                </Badge>
              )}
            </CardContent>
          </Card>
        ))}
        {filtered.length === 0 && <div className="col-span-full"><Empty>Nenhum produto nesta categoria.</Empty></div>}
      </div>

      {dlg && <ProdutoDialog data={dlg} cats={cats} onClose={() => setDlg(null)} onSave={saveProd} />}
      {ajusteDlg && <AjusteEstoqueDialog produto={ajusteDlg} open={!!ajusteDlg} onOpenChange={() => setAjusteDlg(null)} onAjustar={handleAjustarEstoque} />}
      <Dialog open={catDlg} onOpenChange={setCatDlg}>
        <DialogContent><DialogHeader><DialogTitle>Nova categoria</DialogTitle></DialogHeader>
          <div className="space-y-2"><Label>Nome</Label><Input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="Ex: Lanches" /></div>
          <DialogFooter><Button onClick={addCat}>Criar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
function ProdutoDialog({ data, cats, onClose, onSave }) {
  const [f, setF] = useState({ ...data })
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>{f.id ? 'Editar produto' : 'Novo produto'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Nome</Label><Input value={f.nome} onChange={(e) => set('nome', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-2"><Label>Preço (R$)</Label><Input type="number" step="0.01" value={f.preco} onChange={(e) => set('preco', e.target.value)} /></div>
            <div className="space-y-2">
              <Label>Custo (R$)</Label>
              <Input type="number" min="0" step="0.01" placeholder="opcional"
                value={f.custo ?? ''} onChange={(e) => set('custo', e.target.value)} />
            </div>
            <div className="space-y-2"><Label>Categoria</Label>
              <Select value={f.categoria_id || ''} onValueChange={(v) => set('categoria_id', v)}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Custo é quanto você paga para produzir. Deixe vazio se ainda não souber —
            o produto fica de fora do cálculo de CMV até ser preenchido.
          </p>
          <div className="space-y-2"><Label>Descrição</Label><Textarea value={f.descricao || ''} onChange={(e) => set('descricao', e.target.value)} rows={2} /></div>
          <div className="flex items-center justify-between rounded-lg border p-3"><Label>Disponível</Label><Switch checked={f.disponivel !== false} onCheckedChange={(v) => set('disponivel', v)} /></div>

          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center justify-between">
              <Label>Rastrear Estoque</Label>
              <Switch
                checked={f.estoque_habilitado}
                onCheckedChange={(v) => set('estoque_habilitado', v)}
              />
            </div>

            {f.estoque_habilitado && (
              <>
                <div>
                  <Label>Quantidade Atual</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={f.estoque_quantidade || ''}
                    onChange={(e) => set('estoque_quantidade', e.target.value ? Number(e.target.value) : null)}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <Label>Quantidade Mínima (Alerta)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={f.estoque_minimo || '0'}
                    onChange={(e) => set('estoque_minimo', Number(e.target.value))}
                    placeholder="0.00"
                  />
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={() => onSave(f)}>Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AjusteEstoqueDialog({ produto, open, onOpenChange, onAjustar }) {
  const [quantidade, setQuantidade] = useState('')
  const [motivo, setMotivo] = useState('correcao_manual')
  const [loading, setLoading] = useState(false)
  const [erro, setErro] = useState(null)

  const handleAjustar = async () => {
    if (!quantidade || isNaN(quantidade)) {
      setErro('Quantidade inválida')
      return
    }
    setLoading(true)
    setErro(null)
    try {
      await onAjustar({
        produto_id: produto.id,
        quantidade_nova: Number(quantidade),
        motivo,
      })
      setQuantidade('')
      setMotivo('correcao_manual')
      onOpenChange(false)
    } catch (e) {
      setErro(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar Estoque: {produto?.nome}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Quantidade Atual</Label>
            <div className="text-sm text-muted-foreground font-mono font-bold">{produto?.estoque_quantidade || 0}</div>
          </div>
          <div>
            <Label>Quantidade Nova</Label>
            <Input
              type="number"
              step="0.01"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
              placeholder={`Atual: ${produto?.estoque_quantidade || 0}`}
            />
          </div>
          <div>
            <Label>Motivo</Label>
            <select value={motivo} onChange={(e) => setMotivo(e.target.value)} className="w-full border rounded p-2 bg-background">
              <option value="correcao_manual">Correção Manual</option>
              <option value="ajuste_inventario">Ajuste de Inventário</option>
              <option value="devolvido">Devolvido</option>
              <option value="danificado">Danificado</option>
            </select>
          </div>
          {erro && <div className="text-sm text-red-500">{erro}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleAjustar} disabled={loading}>{loading ? 'Ajustando...' : 'Ajustar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ CLIENTES ============================ */
function Clientes() {
  const [list, setList] = useState([])
  const [q, setQ] = useState('')
  const [dlg, setDlg] = useState(null)
  const load = useCallback(() => api('/clientes').then(setList).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const save = async (d) => { try { if (d.id) await api(`/clientes/${d.id}`, { method: 'PUT', body: d }); else await api('/clientes', { method: 'POST', body: d }); toast.success('Cliente salvo'); setDlg(null); load() } catch (e) { toast.error(e.message) } }
  const del = async (id) => { try { await api(`/clientes/${id}`, { method: 'DELETE' }); toast.success('Removido'); load() } catch (e) { toast.error(e.message) } }
  const filtered = list.filter((c) => c.nome.toLowerCase().includes(q.toLowerCase()) || (c.telefone || '').includes(q))
  return (
    <div className="space-y-6">
      <PageHeader title="Clientes" description="Base de clientes do seu restaurante." action={<Button onClick={() => setDlg({ nome: '', telefone: '', email: '', endereco: '', observacoes: '' })}><Plus className="h-4 w-4 mr-1" />Novo cliente</Button>} />
      <div className="relative max-w-sm"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>Telefone</TableHead><TableHead>E-mail</TableHead><TableHead className="text-right">Pedidos</TableHead><TableHead className="text-right">Total gasto</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.nome}</TableCell>
                <TableCell>{c.telefone || '—'}</TableCell>
                <TableCell className="text-muted-foreground">{c.email || '—'}</TableCell>
                <TableCell className="text-right">{c.total_pedidos || 0}</TableCell>
                <TableCell className="text-right font-medium">{brl(c.total_gasto)}</TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setDlg(c)}><Pencil className="h-4 w-4 mr-2" />Editar</DropdownMenuItem><DropdownMenuItem className="text-destructive" onClick={() => del(c.id)}><Trash2 className="h-4 w-4 mr-2" />Remover</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filtered.length === 0 && <Empty>Nenhum cliente encontrado.</Empty>}
      </CardContent></Card>
      {dlg && <ClienteDialog data={dlg} onClose={() => setDlg(null)} onSave={save} />}
    </div>
  )
}
function ClienteDialog({ data, onClose, onSave }) {
  const [f, setF] = useState({ ...data })
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>{f.id ? 'Editar cliente' : 'Novo cliente'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Nome</Label><Input value={f.nome} onChange={set('nome')} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Telefone</Label><Input value={f.telefone} onChange={set('telefone')} placeholder="5511999999999" /></div>
            <div className="space-y-2"><Label>E-mail</Label><Input value={f.email} onChange={set('email')} /></div>
          </div>
          <div className="space-y-2"><Label>Endereço</Label><Input value={f.endereco} onChange={set('endereco')} /></div>
          <div className="space-y-2"><Label>Observações</Label><Textarea rows={2} value={f.observacoes} onChange={set('observacoes')} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={() => onSave(f)}>Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ PEDIDOS (Kanban) ============================ */
function Pedidos({ me }) {
  const [pedidos, setPedidos] = useState([])
  const [entregadores, setEntregadores] = useState([])
  const [dlg, setDlg] = useState(false)
  const [ajuste, setAjuste] = useState(null) // pedido em ajuste de valor
  const [editar, setEditar] = useState(null) // pedido "recebido" sendo editado (itens/tipo/observacoes)
  const [filtroTipo, setFiltroTipo] = useState(null) // null (todas), 'balcao', 'mesa', 'retirada', 'delivery'
  const [sairEntregaModal, setSairEntregaModal] = useState(null) // pedido sendo despachado para entrega
  const [entregadorSelecionado, setEntregadorSelecionado] = useState(null) // entregador selecionado no modal
  const [despachando, setDespachando] = useState(false)
  const [pedidoEstorno, setPedidoEstorno] = useState(null)
  const [estornoValor, setEstornoValor] = useState('')
  const [estornoMotivo, setEstornoMotivo] = useState('')

  // Estorno e o aviso de caixa fechado sao acoes de gerencia — mesmo criterio
  // de papel usado no backend (route.js: GERENTE ou acima) para os endpoints
  // de caixa e de estorno.
  const podeGerenciar = ['OWNER', 'ADMIN', 'GERENTE'].includes(me?.usuario?.papel)

  const load = useCallback(() => {
    api('/pedidos').then(setPedidos).catch((e) => toast.error(e.message))
    api('/entregadores').then(setEntregadores).catch((e) => console.error('Falha ao carregar entregadores:', e.message))
  }, [])
  useEffect(() => { load() }, [load])

  const move = async (p, status) => {
    try {
      await api(`/pedidos/${p.id}`, { method: 'PUT', body: { status } })
      load()
      // Aviso nao bloqueante: a venda acontece normalmente mesmo sem caixa
      // aberto (grava caixa_id nulo no backend). Bloquear porque alguem
      // esqueceu de abrir o caixa seria pior que a falha.
      if (status === 'concluido' && me?.modulos?.caixa !== false) {
        try {
          const atual = await api('/caixa/atual')
          if (!atual.caixa) {
            toast.warning('Caixa fechado', {
              description: 'Esta venda não entrará em nenhuma conferência de caixa.',
            })
          }
        } catch { /* checagem best-effort — nao interfere na conclusao da venda */ }
      }
    } catch (e) { toast.error(e.message) }
  }

  const abrirDialogEstorno = (pedido) => {
    setEstornoValor(String(pedido.total ?? ''))
    setEstornoMotivo('')
    setPedidoEstorno(pedido)
  }

  const handleEstornar = async () => {
    const valor = parseFloat(estornoValor)
    if (!Number.isFinite(valor) || valor <= 0) {
      toast.error('Informe um valor maior que zero')
      return
    }
    if (!estornoMotivo.trim()) {
      toast.error('Informe o motivo do estorno')
      return
    }
    try {
      await api(`/pedidos/${pedidoEstorno.id}/estorno`, {
        method: 'POST',
        body: { valor, motivo: estornoMotivo },
      })
      setPedidoEstorno(null)
      load()
      toast.success('Estorno registrado')
    } catch (e) {
      toast.error(e.message)
    }
  }

  const despacharParaEntrega = async () => {
    if (!sairEntregaModal || !entregadorSelecionado) return
    setDespachando(true)
    try {
      await api(`/pedidos/${sairEntregaModal.id}`, {
        method: 'PATCH',
        body: { status: 'saiu_para_entrega', entregador_id: entregadorSelecionado }
      })
      toast.success('Pedido despachado para entrega')
      setSairEntregaModal(null)
      setEntregadorSelecionado(null)
      load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setDespachando(false)
    }
  }

  const pedidosFiltrados = filtroTipo ? pedidos.filter(p => p.tipo === filtroTipo) : pedidos
  const cols = [...FLOW]
  const FINAIS = ['concluido', 'ENTREGUE', 'cancelado']
  return (
    <div className="space-y-6">
      <PageHeader title="Pedidos" description="Acompanhe e movimente os pedidos pelo fluxo de produção." action={<Button onClick={() => setDlg(true)}><Plus className="h-4 w-4 mr-1" />Novo pedido</Button>} />
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" variant={filtroTipo === null ? 'default' : 'outline'} onClick={() => setFiltroTipo(null)}>Todas</Button>
        <Button size="sm" variant={filtroTipo === 'balcao' ? 'default' : 'outline'} onClick={() => setFiltroTipo('balcao')}>Balcão</Button>
        <Button size="sm" variant={filtroTipo === 'mesa' ? 'default' : 'outline'} onClick={() => setFiltroTipo('mesa')}>Mesa</Button>
        <Button size="sm" variant={filtroTipo === 'retirada' ? 'default' : 'outline'} onClick={() => setFiltroTipo('retirada')}>Retirada</Button>
        <Button size="sm" variant={filtroTipo === 'delivery' ? 'default' : 'outline'} onClick={() => setFiltroTipo('delivery')}>Delivery</Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cols.map((col) => {
          const items = pedidosFiltrados.filter((p) => p.status === col)
          return (
            <div key={col} className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2 font-semibold text-sm"><span className={`h-2 w-2 rounded-full ${STATUS[col].cls.split(' ')[0].replace('/15', '')}`} />{STATUS[col].label}</div>
                <Badge variant="secondary">{items.length}</Badge>
              </div>
              <div className="space-y-3 min-h-[100px]">
                {items.map((p) => {
                  const idx = FLOW.indexOf(p.status)
                  const next = FLOW[idx + 1]
                  return (
                    <Card key={p.id}>
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-center justify-between"><span className="font-semibold">#{p.numero}</span><Badge variant="outline" className="text-xs capitalize">{p.tipo}</Badge></div>
                        <div className="text-sm">{p.cliente_nome}</div>
                        <div className="text-xs text-muted-foreground">{(p.itens || []).map((i) => `${i.quantidade}x ${i.nome}`).join(', ')}</div>

                        {p.tipo === 'delivery' && (
                          <div className="space-y-1 py-1 border-t border-b text-xs">
                            {p.endereco_entrega && (
                              <div className="text-muted-foreground">📍 {p.endereco_entrega.substring(0, 40)}{p.endereco_entrega.length > 40 ? '...' : ''}</div>
                            )}
                            <div className="flex items-center gap-2">
                              {p.taxa_entrega && <span>Taxa: {brl(p.taxa_entrega)}</span>}
                            </div>
                            {p.saiu_para_entrega_em && (
                              <div className="space-y-0.5">
                                {p.entregador_nome && <div>🚗 {p.entregador_nome}</div>}
                                {(() => {
                                  const elapsed = Math.floor((Date.now() - new Date(p.saiu_para_entrega_em)) / 60000)
                                  const estimado = Number(p.entrega_tempo_estimado_min) || 0
                                  const atrasado = estimado > 0 && elapsed > estimado
                                  return (
                                    <div className={atrasado ? 'text-red-500 font-semibold' : ''}>
                                      • há {elapsed} min {atrasado && '⚠️ ATRASADO'}
                                    </div>
                                  )
                                })()}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1">
                          <div className="leading-tight">
                            <span className="font-bold">{brl(p.total)}</span>
                            {(Number(p.desconto) > 0 || Number(p.acrescimo) > 0) && (
                              <span className="block text-[11px] text-muted-foreground">
                                {brl(p.subtotal)}
                                {Number(p.desconto) > 0 && <> · <span className="text-destructive">-{brl(p.desconto)}</span></>}
                                {Number(p.acrescimo) > 0 && <> · +{brl(p.acrescimo)}</>}
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">{fmtDate(p.created_at)}</span>
                        </div>
                        <div className="flex flex-col gap-2 pt-1">
                          {p.tipo === 'delivery' && p.status === 'pronto' && !p.saiu_para_entrega_em ? (
                            <Button size="sm" className="w-full h-8 bg-blue-600 hover:bg-blue-700" onClick={() => { setSairEntregaModal(p); setEntregadorSelecionado(null) }}>
                              Sair para Entrega
                            </Button>
                          ) : next && <Button size="sm" className="w-full h-8" onClick={() => move(p, next)}>{STATUS[next].label} <ArrowUpRight className="h-3.5 w-3.5 ml-1" /></Button>}
                          <div className="flex flex-wrap gap-2">
                            {p.status === 'recebido' && (
                              <Button size="sm" variant="outline" className="h-8" title="Editar pedido (itens, tipo, observações)" onClick={() => setEditar(p)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {!FINAIS.includes(p.status) && (
                              <Button size="sm" variant="outline" className="h-8" title="Ajustar valor (desconto/acrescimo)" onClick={() => setAjuste(p)}>
                                <Percent className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="h-8" title="Imprimir">
                                  <Printer className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => imprimirPedido(p, 'cozinha')}>Via cozinha</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => imprimirPedido(p, 'cliente')}>Via cliente</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {p.status !== 'cancelado' && p.status !== 'concluido' && <Button size="sm" variant="outline" className="h-8 text-destructive" onClick={() => move(p, 'cancelado')}><X className="h-3.5 w-3.5" /></Button>}
                            {['concluido', 'ENTREGUE', 'entregue'].includes(p.status) && podeGerenciar && (
                              <Button size="sm" variant="outline" className="h-8" onClick={() => abrirDialogEstorno(p)}>
                                Estornar
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
                {items.length === 0 && <div className="text-xs text-muted-foreground text-center py-6 border border-dashed rounded-lg">Vazio</div>}
              </div>
            </div>
          )
        })}
      </div>
      {dlg && <PedidoDialog onClose={() => setDlg(false)} onSaved={() => { setDlg(false); load() }} />}
      {ajuste && <AjusteValorDialog pedido={ajuste} onClose={() => setAjuste(null)} onSaved={() => { setAjuste(null); load() }} />}
      {editar && <PedidoDialog pedido={editar} onClose={() => setEditar(null)} onSaved={() => { setEditar(null); load() }} />}
      {sairEntregaModal && (
        <Dialog open onOpenChange={() => setSairEntregaModal(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Escolher Entregador</DialogTitle>
              <DialogDescription>Selecione um entregador para deslocar o pedido #{sairEntregaModal.numero} para entrega.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {entregadores.filter(e => e.ativo === true).length === 0 ? (
                <Empty>Nenhum entregador ativo disponível.</Empty>
              ) : (
                <div className="space-y-2 max-h-60 overflow-auto ros-scroll border rounded-lg divide-y">
                  {entregadores.filter(e => e.ativo === true).map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setEntregadorSelecionado(e.id)}
                      className={`w-full text-left p-3 transition-colors ${
                        entregadorSelecionado === e.id
                          ? 'bg-primary/10 border-l-2 border-primary'
                          : 'hover:bg-accent'
                      }`}
                    >
                      <div className="font-medium">{e.nome}</div>
                      {e.telefone && <div className="text-xs text-muted-foreground">{e.telefone}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSairEntregaModal(null)}>Cancelar</Button>
              <Button
                onClick={despacharParaEntrega}
                disabled={!entregadorSelecionado || despachando}
              >
                {despachando && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Confirmar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={pedidoEstorno !== null} onOpenChange={(v) => !v && setPedidoEstorno(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Estornar pedido #{pedidoEstorno?.numero}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              O valor do pedido não muda. O estorno entra como lançamento separado no
              financeiro, preservando o histórico da venda.
            </p>
            <div>
              <Label>Valor a estornar (R$)</Label>
              <Input type="number" min="0" step="0.01" value={estornoValor}
                onChange={(e) => setEstornoValor(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">
                Total do pedido: {brl(pedidoEstorno?.total ?? 0)}. Estorno parcial é permitido.
              </p>
            </div>
            <div>
              <Label>Motivo</Label>
              <Input value={estornoMotivo} onChange={(e) => setEstornoMotivo(e.target.value)}
                placeholder="ex: cliente desistiu do pedido" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setPedidoEstorno(null)}>Cancelar</Button>
              <Button className="flex-1" onClick={handleEstornar}>Confirmar estorno</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Ajuste de valor de um pedido ja criado (desconto/acrescimo). O subtotal dos
 * itens nao muda aqui — para isso o caminho e alterar os itens. O servidor
 * recalcula o total a partir do subtotal gravado e recusa alterar pedido ja
 * concluido (nesse ponto ele ja virou receita no financeiro).
 */
function AjusteValorDialog({ pedido, onClose, onSaved }) {
  const [desconto, setDesconto] = useState(String(pedido.desconto ?? 0))
  const [acrescimo, setAcrescimo] = useState(String(pedido.acrescimo ?? 0))
  const [saving, setSaving] = useState(false)

  const subtotal = Number(pedido.subtotal) || Number(pedido.total) || 0
  const descontoNum = Math.max(0, Number(desconto) || 0)
  const acrescimoNum = Math.max(0, Number(acrescimo) || 0)
  const total = subtotal - descontoNum + acrescimoNum
  const excede = descontoNum > subtotal + acrescimoNum

  const salvar = async () => {
    if (excede) return toast.error('O desconto nao pode ser maior que o valor do pedido')
    setSaving(true)
    try {
      await api(`/pedidos/${pedido.id}`, { method: 'PUT', body: { desconto: descontoNum, acrescimo: acrescimoNum } })
      toast.success('Valor ajustado')
      onSaved()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ajustar valor — pedido #{pedido.numero}</DialogTitle>
          <DialogDescription>Aplique desconto ou acrescimo. O subtotal dos itens nao muda.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ajuste-desconto">Desconto (R$)</Label>
              <Input id="ajuste-desconto" type="number" min="0" step="0.01" inputMode="decimal" autoFocus
                value={desconto} onChange={(e) => setDesconto(e.target.value)} aria-invalid={excede || undefined} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ajuste-acrescimo">Acrescimo (R$)</Label>
              <Input id="ajuste-acrescimo" type="number" min="0" step="0.01" inputMode="decimal"
                value={acrescimo} onChange={(e) => setAcrescimo(e.target.value)} />
            </div>
          </div>
          {excede && <p className="text-xs text-destructive">O desconto nao pode ser maior que o valor do pedido.</p>}
          <div className="rounded-lg border p-3 space-y-1 text-sm">
            <div className="flex items-center justify-between text-muted-foreground"><span>Subtotal</span><span>{brl(subtotal)}</span></div>
            {descontoNum > 0 && <div className="flex items-center justify-between text-muted-foreground"><span>Desconto</span><span>- {brl(descontoNum)}</span></div>}
            {acrescimoNum > 0 && <div className="flex items-center justify-between text-muted-foreground"><span>Acrescimo</span><span>+ {brl(acrescimoNum)}</span></div>}
            <div className="flex items-center justify-between font-bold text-base pt-1 border-t"><span>Total</span><span>{brl(Math.max(0, total))}</span></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={salvar} disabled={saving || excede}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
/**
 * Cria um pedido novo OU edita um ja existente (Fix: pedidos "Recebido" nao
 * podiam ser corrigidos — so tinham botoes de status/cancelar). Passar
 * `pedido` entra em modo edicao: reaproveita a mesma UI de itens/tipo, troca
 * POST /pedidos por PUT /pedidos/:id e esconde o que nao se aplica a um
 * pedido ja criado (tipo "mesa" e a troca de cliente, que essa rota nao
 * atualiza no backend).
 */
function PedidoDialog({ onClose, onSaved, clienteInicial = null, pedido = null }) {
  const isEditing = !!pedido
  const [prods, setProds] = useState([])
  const [mesasLivres, setMesasLivres] = useState([])
  const [clientes, setClientes] = useState([])
  const [empresaConfig, setEmpresaConfig] = useState(null)
  const [itens, setItens] = useState(() => (pedido?.itens || []).map((i) => ({ ...i })))
  const [cliente_id, setCliente] = useState(pedido?.cliente_id ?? clienteInicial)
  const [tipo, setTipo] = useState(pedido?.tipo || 'balcao')
  const [pagamento, setPag] = useState(pedido?.pagamento || 'pix')
  const [mesa_id, setMesaId] = useState('')
  const [pessoas, setPessoas] = useState(2)
  const [observacoes, setObservacoes] = useState(pedido?.observacoes || '')
  const [desconto, setDesconto] = useState(pedido?.desconto ? String(pedido.desconto) : '')
  const [acrescimo, setAcrescimo] = useState(pedido?.acrescimo ? String(pedido.acrescimo) : '')
  const [entregaEndereco, setEntregaEndereco] = useState(pedido?.entrega_endereco || '')
  const [entregaTaxa, setEntregaTaxa] = useState(pedido?.entrega_taxa ? String(pedido.entrega_taxa) : '')
  const [entregaTempoEstimado, setEntregaTempoEstimado] = useState(pedido?.entrega_tempo_estimado_min ? String(pedido.entrega_tempo_estimado_min) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Falha aqui nao pode virar "lista vazia" indistinguivel de "sem produtos
    // cadastrados" — o operador precisa saber que o carregamento quebrou, nao
    // so ver um dialog de pedido sem nada pra escolher.
    api('/produtos').then(setProds).catch((e) => console.error('Falha ao carregar produtos no dialog de pedido:', e.message))
    api('/clientes').then(setClientes).catch((e) => console.error('Falha ao carregar clientes no dialog de pedido:', e.message))
    api('/empresa').then(setEmpresaConfig).catch((e) => console.error('Falha ao carregar config da empresa no dialog de pedido:', e.message))
    if (!isEditing) api('/mesas').then((m) => setMesasLivres((m || []).filter((x) => x.status === 'livre'))).catch((e) => console.error('Falha ao carregar mesas no dialog de pedido:', e.message))
  }, [isEditing])

  // Pre-fill delivery fields when tipo changes or cliente changes
  useEffect(() => {
    if (!isEditing && tipo === 'delivery') {
      // Pre-fill endereco from cliente if exists
      if (cliente_id) {
        const cliente = clientes.find((c) => c.id === cliente_id)
        if (cliente?.endereco) {
          setEntregaEndereco(cliente.endereco)
        }
      }

      // Pre-fill taxa and tempo from empresa config
      if (empresaConfig?.config?.delivery) {
        if (!entregaTaxa && empresaConfig.config.delivery.taxa_padrao) {
          setEntregaTaxa(String(empresaConfig.config.delivery.taxa_padrao))
        }
        if (!entregaTempoEstimado && empresaConfig.config.delivery.tempo_estimado_min) {
          setEntregaTempoEstimado(String(empresaConfig.config.delivery.tempo_estimado_min))
        }
      }
    } else if (!isEditing && tipo !== 'delivery') {
      // Clear delivery fields if not delivery
      setEntregaEndereco('')
      setEntregaTaxa('')
      setEntregaTempoEstimado('')
    }
  }, [tipo, cliente_id, isEditing, clientes, empresaConfig])
  const add = (p, observacao = '') => setItens((s) => {
    const ex = s.find((i) => i.produto_id === p.id && (i.observacao || '') === observacao)
    if (ex) return s.map((i) => i === ex ? { ...i, quantidade: i.quantidade + 1 } : i)
    return [...s, { produto_id: p.id, nome: p.nome, preco: p.preco, quantidade: 1, observacao }]
  })
  const dec = (id, observacao = '') => setItens((s) => s
    .map((i) => (i.produto_id === id && (i.observacao || '') === observacao) ? { ...i, quantidade: Math.max(0, i.quantidade - 1) } : i)
    .filter((i) => i.quantidade > 0))
  const subtotal = itens.reduce((s, i) => s + i.preco * i.quantidade, 0)
  const descontoNum = Math.max(0, Number(desconto) || 0)
  const acrescimoNum = Math.max(0, Number(acrescimo) || 0)
  const entregaTaxaNum = tipo === 'delivery' ? Math.max(0, Number(entregaTaxa) || 0) : 0
  const total = Math.max(0, subtotal - descontoNum + acrescimoNum + entregaTaxaNum)
  const descontoExcede = descontoNum > subtotal + acrescimoNum

  const save = async () => {
    if (!itens.length) return toast.error('Adicione ao menos 1 item')
    if (descontoExcede) return toast.error('O desconto nao pode ser maior que o valor do pedido')
    setSaving(true)
    try {
      if (isEditing) {
        const payload = { itens, tipo, pagamento, observacoes, desconto: descontoNum, acrescimo: acrescimoNum }
        if (tipo === 'delivery') {
          payload.entrega_endereco = entregaEndereco
          payload.entrega_taxa = entregaTaxaNum
          payload.entrega_tempo_estimado_min = entregaTempoEstimado ? Number(entregaTempoEstimado) : null
        }
        await api(`/pedidos/${pedido.id}`, { method: 'PUT', body: payload })
        toast.success('Pedido atualizado')
      } else if (tipo === 'mesa') {
        if (!mesa_id) { setSaving(false); return toast.error('Selecione a mesa') }
        const comanda = await api(`/mesas/${mesa_id}/abrir`, { method: 'POST', body: { cliente_id, pessoas } })
        for (const it of itens) await api(`/comandas/${comanda.id}/itens`, { method: 'POST', body: { produto_id: it.produto_id, quantidade: it.quantidade, observacao: it.observacao || '' } })
        toast.success('Comanda aberta na mesa')
      } else {
        const payload = { itens, cliente_id, tipo, pagamento, observacoes, desconto: descontoNum, acrescimo: acrescimoNum }
        if (tipo === 'delivery') {
          payload.entrega_endereco = entregaEndereco
          payload.entrega_taxa = entregaTaxaNum
          payload.entrega_tempo_estimado_min = entregaTempoEstimado ? Number(entregaTempoEstimado) : null
        }
        await api('/pedidos', { method: 'POST', body: payload })
        toast.success('Pedido criado')
      }
      onSaved()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? `Editar pedido #${pedido.numero}` : 'Novo pedido'}</DialogTitle>
          <DialogDescription>{isEditing ? 'Ajuste os itens, o tipo de atendimento e as observações.' : 'Selecione os itens, o cliente e o tipo de atendimento.'}</DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Produtos</Label>
            <div className="border rounded-lg divide-y max-h-72 overflow-auto ros-scroll">
              {prods.filter((p) => p.disponivel !== false).map((p) => (
                <button key={p.id} onClick={() => add(p)} className="w-full flex items-center justify-between p-3 hover:bg-accent text-left text-sm">
                  <span>{p.nome}</span><span className="text-muted-foreground">{brl(p.preco)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {/* Troca de cliente fica de fora da edicao: PUT /pedidos/:id nao
                atualiza cliente_id/cliente_nome no backend, entao mostrar o
                picker aqui enganaria o operador (pareceria editavel e nao e). */}
            {isEditing ? (
              <div className="space-y-1"><Label className="text-xs">Cliente</Label>
                <div className="rounded-lg border p-2.5 text-sm">{pedido.cliente_nome}</div>
              </div>
            ) : (
              <ClientePicker value={cliente_id} onChange={setCliente} />
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label className="text-xs">Tipo</Label>
                <Select value={tipo} onValueChange={setTipo}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="balcao">Balcao</SelectItem><SelectItem value="delivery">Delivery</SelectItem><SelectItem value="retirada">Retirada</SelectItem>{!isEditing && <SelectItem value="mesa">Mesa</SelectItem>}</SelectContent></Select>
              </div>
              {tipo === 'mesa' && !isEditing ? (
                <div className="space-y-1"><Label className="text-xs">Mesa</Label>
                  <Select value={mesa_id} onValueChange={setMesaId}><SelectTrigger><SelectValue placeholder="Selecionar" /></SelectTrigger><SelectContent>{mesasLivres.map((m) => <SelectItem key={m.id} value={m.id}>{m.nome}</SelectItem>)}</SelectContent></Select>
                </div>
              ) : (
                <div className="space-y-1"><Label className="text-xs">Pagamento</Label>
                  <Select value={pagamento} onValueChange={setPag}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pix">Pix</SelectItem><SelectItem value="cartao">Cartao</SelectItem><SelectItem value="dinheiro">Dinheiro</SelectItem></SelectContent></Select>
                </div>
              )}
            </div>
            {tipo === 'mesa' && !isEditing && <div className="space-y-1"><Label className="text-xs">Pessoas</Label><Input type="number" min={1} value={pessoas} onChange={(e) => setPessoas(e.target.value)} /></div>}
            {tipo === 'delivery' && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="entrega-endereco">Endereço de Entrega</Label>
                  <Input id="entrega-endereco" value={entregaEndereco} onChange={(e) => setEntregaEndereco(e.target.value)} placeholder="Rua, número, complemento..." />
                  {!entregaEndereco && cliente_id && !clientes.find((c) => c.id === cliente_id)?.endereco && (
                    <p className="text-xs text-amber-600">Cliente sem endereço cadastrado</p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="entrega-taxa">Taxa de Entrega (R$)</Label>
                    <Input id="entrega-taxa" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0,00"
                      value={entregaTaxa} onChange={(e) => setEntregaTaxa(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="entrega-tempo">Tempo Estimado (min)</Label>
                    <Input id="entrega-tempo" type="number" min="1" inputMode="numeric" placeholder="30"
                      value={entregaTempoEstimado} onChange={(e) => setEntregaTempoEstimado(e.target.value)} />
                  </div>
                </div>
              </>
            )}
            <Separator />
            <div className="space-y-2 max-h-40 overflow-auto ros-scroll">
              {itens.length === 0 && <p className="text-sm text-muted-foreground">Nenhum item adicionado.</p>}
              {itens.map((i, idx) => (
                <div key={`${i.produto_id}-${i.observacao || ''}`} className="space-y-1 text-sm border-b pb-2 last:border-0">
                  <div className="flex items-center justify-between">
                    <span className="flex-1">{i.nome}</span>
                    <div className="flex items-center gap-2"><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => dec(i.produto_id, i.observacao)}><Minus className="h-3 w-3" /></Button><span className="w-5 text-center">{i.quantidade}</span><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => add({ id: i.produto_id, nome: i.nome, preco: i.preco }, i.observacao)}><Plus className="h-3 w-3" /></Button></div>
                    <span className="w-20 text-right font-medium">{brl(i.preco * i.quantidade)}</span>
                  </div>
                  <Input
                    placeholder="Observacao (opcional) — ex: sem cebola"
                    className="h-7 text-xs"
                    value={i.observacao || ''}
                    onChange={(e) => setItens((s) => s.map((it, ix) => ix === idx ? { ...it, observacao: e.target.value } : it))}
                  />
                </div>
              ))}
            </div>
            {/* Observacao geral do pedido (ex: "sem talheres", "entregar na
                portaria"). Nao se aplica ao tipo "mesa": ali quem acumula
                observacoes e a comanda, item a item, na tela de Mesas. */}
            {tipo !== 'mesa' && (
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="pedido-observacoes">Observações do pedido</Label>
                <Textarea id="pedido-observacoes" placeholder="Ex: sem talheres, entregar na portaria…" className="text-sm min-h-16"
                  value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
              </div>
            )}
            {/* Ajuste de valor: so faz sentido no pedido direto. No tipo "mesa"
                quem controla desconto/taxa e a comanda, na tela de Mesas. */}
            {tipo !== 'mesa' && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="pedido-desconto">Desconto (R$)</Label>
                    <Input id="pedido-desconto" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0,00"
                      value={desconto} onChange={(e) => setDesconto(e.target.value)} aria-invalid={descontoExcede || undefined} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor="pedido-acrescimo">Acrescimo (R$)</Label>
                    <Input id="pedido-acrescimo" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0,00"
                      value={acrescimo} onChange={(e) => setAcrescimo(e.target.value)} />
                  </div>
                </div>
                {descontoExcede && <p className="text-xs text-destructive">O desconto nao pode ser maior que o valor do pedido.</p>}
              </>
            )}
            <div className="space-y-1 pt-2 border-t text-sm">
              <div className="flex items-center justify-between text-muted-foreground"><span>Subtotal</span><span>{brl(subtotal)}</span></div>
              {descontoNum > 0 && <div className="flex items-center justify-between text-muted-foreground"><span>Desconto</span><span>- {brl(descontoNum)}</span></div>}
              {acrescimoNum > 0 && <div className="flex items-center justify-between text-muted-foreground"><span>Acrescimo</span><span>+ {brl(acrescimoNum)}</span></div>}
              {entregaTaxaNum > 0 && <div className="flex items-center justify-between text-muted-foreground"><span>Taxa de Entrega</span><span>+ {brl(entregaTaxaNum)}</span></div>}
              <div className="flex items-center justify-between font-bold text-lg pt-1"><span>Total</span><span>{brl(total)}</span></div>
            </div>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{isEditing ? 'Salvar alterações' : (tipo === 'mesa' ? 'Abrir comanda' : 'Criar pedido')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ FINANCEIRO ============================ */
function Financeiro({ temMod = () => true }) {
  const temCaixa = temMod('caixa')
  const [resumo, setResumo] = useState(null)
  const [tx, setTx] = useState([])
  const [dlg, setDlg] = useState(false)

  // Caixa (fundo de troco / abertura-fechamento de turno). `caixaResumo` e
  // `caixaMovimentos` sao reaproveitados pelas Tasks 11 (sangria/suprimento/
  // fechamento) e 12 (impressao/relatorio de fechamento).
  const [caixaAtual, setCaixaAtual] = useState(null)
  const [caixaResumo, setCaixaResumo] = useState(null)
  const [caixaMovimentos, setCaixaMovimentos] = useState([])
  const [caixaHistorico, setCaixaHistorico] = useState([])
  const [dialogAbrirCaixa, setDialogAbrirCaixa] = useState(false)
  const [dialogFecharCaixa, setDialogFecharCaixa] = useState(false)
  const [valorAbertura, setValorAbertura] = useState('')
  const [dialogMovimento, setDialogMovimento] = useState(null) // 'sangria' | 'suprimento' | null
  const [movimentoValor, setMovimentoValor] = useState('')
  const [movimentoMotivo, setMovimentoMotivo] = useState('')
  const [valorContado, setValorContado] = useState('')
  const [obsFechamento, setObsFechamento] = useState('')

  const load = useCallback(async () => { const [r, t] = await Promise.all([api('/financeiro/resumo'), api('/financeiro/transacoes')]); setResumo(r); setTx(t) }, [])
  useEffect(() => { load().catch((e) => toast.error(e.message)) }, [load])
  const save = async (d) => { try { await api('/financeiro/transacoes', { method: 'POST', body: d }); toast.success('Lançamento adicionado'); setDlg(false); load() } catch (e) { toast.error(e.message) } }

  const carregarCaixa = useCallback(async () => {
    // Sem o modulo, as rotas de caixa devolvem 403 — chamar so para mostrar um
    // toast de erro ao abrir o Financeiro seria ruido puro.
    if (!temCaixa) return
    try {
      const atual = await api('/caixa/atual')
      setCaixaAtual(atual.caixa)
      setCaixaResumo(atual.resumo)
      setCaixaMovimentos(atual.movimentos || [])
      const hist = await api('/caixa/historico?limite=10')
      setCaixaHistorico(hist.caixas || [])
    } catch (e) { toast.error(`Falha ao carregar status do caixa: ${e.message}`) }
  }, [temCaixa])
  useEffect(() => { carregarCaixa() }, [carregarCaixa])

  const abrirDialogMovimento = useCallback((tipo) => {
    setMovimentoValor('')
    setMovimentoMotivo('')
    setDialogMovimento(tipo)
  }, [])

  const handleAbrirCaixa = async () => {
    const valor = parseFloat(valorAbertura)
    if (!Number.isFinite(valor) || valor < 0) {
      toast.error('Informe o fundo de troco')
      return
    }
    try {
      await api('/caixa/abrir', { method: 'POST', body: { valor_abertura: valor } })
      setDialogAbrirCaixa(false)
      setValorAbertura('')
      await carregarCaixa()
      toast.success('Caixa aberto')
    } catch (e) {
      toast.error(e.message)
    }
  }

  const handleRegistrarMovimento = async () => {
    const valor = parseFloat(movimentoValor)
    if (!Number.isFinite(valor) || valor <= 0) {
      toast.error('Informe um valor maior que zero')
      return
    }
    try {
      await api('/caixa/movimento', {
        method: 'POST',
        body: { tipo: dialogMovimento, valor, motivo: movimentoMotivo },
      })
      setDialogMovimento(null)
      await carregarCaixa()
      toast.success(dialogMovimento === 'sangria' ? 'Sangria registrada' : 'Suprimento registrado')
    } catch (e) {
      toast.error(e.message)
    }
  }

  const handleFecharCaixa = async () => {
    const contado = parseFloat(valorContado)
    if (!Number.isFinite(contado) || contado < 0) {
      toast.error('Informe o valor contado')
      return
    }
    try {
      await api('/caixa/fechar', {
        method: 'POST',
        body: { valor_contado: contado, observacoes: obsFechamento },
      })
      setDialogFecharCaixa(false)
      setValorContado('')
      setObsFechamento('')
      await carregarCaixa()
      toast.success('Caixa fechado')
    } catch (e) {
      toast.error(e.message)
    }
  }

  if (!resumo) return <Empty>Carregando…</Empty>
  return (
    <div className="space-y-6">
      <PageHeader title="Financeiro" description="Visão geral, lançamentos e relatórios do restaurante." />

      {temCaixa && (caixaAtual ? (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm text-muted-foreground">
                  Caixa aberto desde {new Date(caixaAtual.aberto_em).toLocaleString('pt-BR')}
                  {caixaAtual.aberto_por_nome ? ` por ${caixaAtual.aberto_por_nome}` : ''}
                </div>
                <div className="text-2xl font-semibold">
                  {brl(caixaResumo?.valor_esperado ?? 0)}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">em dinheiro na gaveta</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button variant="outline" onClick={() => abrirDialogMovimento('sangria')}>Sangria</Button>
                <Button variant="outline" onClick={() => abrirDialogMovimento('suprimento')}>Suprimento</Button>
                <Button onClick={() => setDialogFecharCaixa(true)} className="col-span-2 sm:col-span-1">
                  Fechar caixa
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-sm text-muted-foreground">
              Caixa fechado. Abra o caixa para conferir o dinheiro no fim do dia.
            </div>
            <Button onClick={() => setDialogAbrirCaixa(true)}>Abrir caixa</Button>
          </CardContent>
        </Card>
      ))}

      {temCaixa && caixaAtual && caixaMovimentos.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Movimentos deste caixa</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {caixaMovimentos.map((m) => (
              <div key={m.id} className="flex justify-between">
                <span>
                  {m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}
                  {m.motivo ? ` — ${m.motivo}` : ''}
                  <span className="ml-2 text-xs text-muted-foreground">{m.usuario_nome}</span>
                </span>
                <span className={m.tipo === 'sangria' ? 'text-red-600' : 'text-emerald-600'}>
                  {m.tipo === 'sangria' ? '-' : '+'} {brl(m.valor)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {temCaixa && <Card>
        <CardHeader><CardTitle className="text-base">Caixas anteriores</CardTitle></CardHeader>
        <CardContent>
          {caixaHistorico.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum caixa fechado ainda.</p>
          ) : (
            <div className="space-y-2 text-sm">
              {caixaHistorico.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                  <div>
                    <div className="font-medium">{new Date(c.fechado_em).toLocaleDateString('pt-BR')}</div>
                    <div className="text-xs text-muted-foreground">
                      Abriu: {c.aberto_por_nome || '—'} · Fechou: {c.fechado_por_nome || '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">
                      Esperado {brl(c.valor_esperado ?? 0)} · Contado {brl(c.valor_contado ?? 0)}
                    </div>
                    <div className={`font-medium ${
                      (c.diferenca ?? 0) === 0 ? '' : (c.diferenca ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600'
                    }`}>
                      {(c.diferenca ?? 0) === 0 ? 'Conferiu' : `Diferença ${brl(c.diferenca ?? 0)}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>}

      <Tabs defaultValue="visao">
        <TabsList><TabsTrigger value="visao">Visão Geral</TabsTrigger><TabsTrigger value="lancamentos">Lançamentos</TabsTrigger><TabsTrigger value="relatorios">Relatórios</TabsTrigger></TabsList>

        <TabsContent value="visao" className="mt-4 space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={TrendingUp} label="Receitas" value={brl(resumo.receitas)} tone="emerald" />
            <Stat icon={TrendingDown} label="Despesas" value={brl(resumo.despesas)} tone="amber" />
            <Stat icon={Wallet} label="Saldo" value={brl(resumo.saldo)} tone={resumo.saldo >= 0 ? 'primary' : 'amber'} />
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Receitas x Despesas — 7 dias</CardTitle></CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={resumo.serie} margin={{ left: -18, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="dia" tickLine={false} axisLine={false} fontSize={12} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} stroke="hsl(var(--muted-foreground))" />
                  <RTooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} formatter={(v) => brl(v)} />
                  <Bar dataKey="receita" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="despesa" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="lancamentos" className="mt-4 space-y-4">
          <div className="flex justify-end"><Button onClick={() => setDlg(true)}><Plus className="h-4 w-4 mr-1" />Lançamento</Button></div>
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Descrição</TableHead><TableHead>Categoria</TableHead><TableHead>Tipo</TableHead><TableHead className="text-right">Valor</TableHead><TableHead className="text-right">Data</TableHead></TableRow></TableHeader>
              <TableBody>
                {tx.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.descricao || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{t.categoria}</TableCell>
                    <TableCell><Badge variant="outline" className={t.tipo === 'receita' ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/10' : 'text-amber-500 border-amber-500/20 bg-amber-500/10'}>{t.tipo}</Badge></TableCell>
                    <TableCell className={`text-right font-medium ${t.tipo === 'receita' ? 'text-emerald-500' : 'text-amber-500'}`}>{t.tipo === 'receita' ? '+' : '-'}{brl(t.valor)}</TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">{fmtDate(t.data)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {tx.length === 0 && <Empty>Nenhum lançamento.</Empty>}
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="relatorios" className="mt-4"><Relatorios /></TabsContent>
      </Tabs>
      {dlg && <TxDialog onClose={() => setDlg(false)} onSave={save} />}

      <Dialog open={dialogAbrirCaixa} onOpenChange={setDialogAbrirCaixa}>
        <DialogContent>
          <DialogHeader><DialogTitle>Abrir caixa</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Fundo de troco (R$)</Label>
              <Input
                type="number" min="0" step="0.01" value={valorAbertura}
                onChange={(e) => setValorAbertura(e.target.value)}
                placeholder="0,00"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Dinheiro que já está na gaveta agora, antes da primeira venda.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setDialogAbrirCaixa(false)}>Cancelar</Button>
              <Button className="flex-1" onClick={handleAbrirCaixa}>Abrir</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMovimento !== null} onOpenChange={(v) => !v && setDialogMovimento(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogMovimento === 'sangria' ? 'Sangria' : 'Suprimento'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {dialogMovimento === 'sangria'
                ? 'Retirada de dinheiro da gaveta para o cofre ou o banco. Não é despesa.'
                : 'Entrada de dinheiro na gaveta, geralmente troco. Não é receita.'}
            </p>
            <div>
              <Label>Valor (R$)</Label>
              <Input type="number" min="0" step="0.01" value={movimentoValor}
                onChange={(e) => setMovimentoValor(e.target.value)} placeholder="0,00" />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input value={movimentoMotivo} onChange={(e) => setMovimentoMotivo(e.target.value)}
                placeholder="ex: depósito no banco" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setDialogMovimento(null)}>Cancelar</Button>
              <Button className="flex-1" onClick={handleRegistrarMovimento}>Registrar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogFecharCaixa} onOpenChange={setDialogFecharCaixa}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Fechar caixa</DialogTitle></DialogHeader>

          {(() => {
            const esperado = caixaResumo?.valor_esperado ?? 0
            const contado = parseFloat(valorContado)
            const temContado = Number.isFinite(contado)
            const diferenca = temContado ? Math.round((contado - esperado) * 100) / 100 : 0
            const porForma = caixaResumo?.por_forma_pagamento || {}

            return (
              <div className="space-y-4">
                <div className="rounded-md border p-3 text-sm">
                  <div className="mb-2 font-medium">Recebido neste caixa</div>
                  {Object.keys(porForma).length === 0 ? (
                    <div className="text-muted-foreground">Nenhuma venda registrada.</div>
                  ) : (
                    Object.entries(porForma).map(([forma, valor]) => (
                      <div key={forma} className="flex justify-between">
                        <span className="capitalize">{forma === 'nao_informado' ? 'não informado' : forma}</span>
                        <span>{brl(valor)}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="rounded-md border p-3 text-sm">
                  <div className="flex justify-between"><span>Fundo de troco</span><span>{brl(caixaResumo?.valor_abertura ?? 0)}</span></div>
                  <div className="flex justify-between"><span>+ Vendas em dinheiro</span><span>{brl(caixaResumo?.receitas_dinheiro ?? 0)}</span></div>
                  <div className="flex justify-between"><span>- Estornos em dinheiro</span><span>{brl(caixaResumo?.estornos_dinheiro ?? 0)}</span></div>
                  <div className="flex justify-between"><span>+ Suprimentos</span><span>{brl(caixaResumo?.suprimentos ?? 0)}</span></div>
                  <div className="flex justify-between"><span>- Sangrias</span><span>{brl(caixaResumo?.sangrias ?? 0)}</span></div>
                  <div className="mt-2 flex justify-between border-t pt-2 font-semibold">
                    <span>Esperado na gaveta</span><span>{brl(esperado)}</span>
                  </div>
                </div>

                <div>
                  <Label>Valor contado na gaveta (R$)</Label>
                  <Input type="number" min="0" step="0.01" value={valorContado}
                    onChange={(e) => setValorContado(e.target.value)} placeholder="0,00" />
                </div>

                {temContado && (
                  <div className={`rounded-md p-3 text-sm font-medium ${
                    diferenca === 0 ? 'bg-muted'
                      : diferenca > 0 ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'bg-red-500/10 text-red-700 dark:text-red-400'
                  }`}>
                    {diferenca === 0
                      ? 'Caixa confere exatamente.'
                      : diferenca > 0
                        ? `Sobra de ${brl(diferenca)}`
                        : `Falta de ${brl(Math.abs(diferenca))}`}
                  </div>
                )}

                <div>
                  <Label>Observações {temContado && diferenca !== 0 ? '(obrigatório)' : '(opcional)'}</Label>
                  <Textarea value={obsFechamento} onChange={(e) => setObsFechamento(e.target.value)}
                    placeholder="O que explica a diferença?" rows={3} />
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setDialogFecharCaixa(false)}>Cancelar</Button>
                  <Button className="flex-1" onClick={handleFecharCaixa}
                    disabled={!temContado || (diferenca !== 0 && !obsFechamento.trim())}>
                    Confirmar fechamento
                  </Button>
                </div>
              </div>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}

const REL_PRESETS = [
  ['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'],
  ['mes', 'Este mês'], ['mes_ant', 'Mês anterior'], ['custom', 'Personalizado'],
]
function presetRange(p) {
  const now = new Date(); const end = new Date(now); const start = new Date(now)
  const d0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  if (p === 'hoje') return [d0(now), now]
  if (p === 'ontem') { const y = new Date(now.getTime() - 86400000); return [d0(y), new Date(d0(y).getTime() + 86399999)] }
  if (p === '7d') return [d0(new Date(now.getTime() - 6 * 86400000)), now]
  if (p === '30d') return [d0(new Date(now.getTime() - 29 * 86400000)), now]
  if (p === 'mes') return [d0(new Date(now.getFullYear(), now.getMonth(), 1)), now]
  if (p === 'mes_ant') return [d0(new Date(now.getFullYear(), now.getMonth() - 1, 1)), new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)]
  return [start, end]
}

/**
 * DRE simplificado (Demonstrativo de Resultado): a cascata receita -> CMV ->
 * lucro bruto -> despesas operacionais -> lucro liquido, mais o ponto de
 * equilibrio. A formula vive em lib/financeiro.js — este componente so exibe.
 *
 * So aparece quando ha alguma despesa OU receita no periodo: DRE de um
 * periodo totalmente vazio nao ensina nada e so ocupa espaco.
 */
function DreCard({ dre, despesasPorCategoria, coberturaCmv }) {
  if (dre.receita_total === 0 && dre.total_despesas_operacionais === 0) return null

  const linha = (label, valor, opts = {}) => (
    <div className={`flex items-center justify-between py-1.5 ${opts.total ? 'border-t mt-1 pt-2 font-semibold' : ''} ${opts.indent ? 'pl-4 text-muted-foreground' : ''}`}>
      <span className={opts.total ? '' : 'text-sm'}>{label}</span>
      <span className={opts.total ? '' : 'text-sm'}>{valor}</span>
    </div>
  )

  const NATUREZA_LABEL = { fixa: 'Fixa', variavel: 'Variável', mista: 'Mista', null: 'Não classificada' }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">DRE — Demonstrativo de Resultado</CardTitle>
          <CardDescription>Receita até lucro líquido, o número que diz se o período fechou no azul.</CardDescription>
        </CardHeader>
        <CardContent>
          {linha('Receita', brl(dre.receita_total))}
          {linha('(–) Custo da mercadoria (CMV)', `– ${brl(dre.custo_mercadoria)}`, { indent: true })}
          {linha('= Lucro bruto', brl(dre.lucro_bruto), { total: true })}
          {linha('(–) Despesas fixas', `– ${brl(dre.despesas_fixas)}`, { indent: true })}
          {linha('(–) Despesas variáveis', `– ${brl(dre.despesas_variaveis)}`, { indent: true })}
          {dre.despesas_nao_classificadas > 0 && linha('(–) Despesas não classificadas', `– ${brl(dre.despesas_nao_classificadas)}`, { indent: true })}
          {linha('= Lucro líquido', <span className={dre.lucro_liquido >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{brl(dre.lucro_liquido)}</span>, { total: true })}
          {dre.margem_liquida_percent !== null && (
            <p className="text-xs text-muted-foreground mt-2">Margem líquida: {dre.margem_liquida_percent.toFixed(1).replace('.', ',')}% da receita</p>
          )}
          {dre.despesas_nao_classificadas > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {brl(dre.despesas_nao_classificadas)} em despesas sem natureza definida (fixa/variável) — não entram no ponto de equilíbrio abaixo. Edite o lançamento para classificar.
            </p>
          )}
          <div className="mt-4 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-1.5"><Percent className="h-4 w-4" />Ponto de equilíbrio (mensal)</span>
              <span className="font-semibold">{dre.ponto_equilibrio !== null ? brl(dre.ponto_equilibrio) : '—'}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {dre.ponto_equilibrio !== null
                ? 'Receita mínima no período para cobrir custos fixos e variáveis, sem lucro nem prejuízo.'
                : 'Precisa de despesa fixa cadastrada e receita no período para calcular.'}
            </p>
            {coberturaCmv !== undefined && coberturaCmv !== null && coberturaCmv < 90 && dre.ponto_equilibrio !== null && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Apenas {coberturaCmv.toFixed(0)}% da receita tem custo de mercadoria cadastrado — este número tende a ficar mais preciso conforme mais produtos tiverem custo cadastrado.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Despesas por categoria</CardTitle>
          <CardDescription>Onde o dinheiro saiu — pessoal, aluguel, insumo, energia, o que for.</CardDescription>
        </CardHeader>
        <CardContent>
          {(!despesasPorCategoria || despesasPorCategoria.length === 0) ? (
            <p className="text-sm text-muted-foreground">Nenhuma despesa no período.</p>
          ) : (
            <div className="space-y-2">
              {despesasPorCategoria.map((d) => (
                <div key={d.categoria} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                  <div>
                    <div className="font-medium">{d.categoria}</div>
                    <div className="text-xs text-muted-foreground">{NATUREZA_LABEL[d.natureza ?? 'null']}</div>
                  </div>
                  <span className="font-medium">{brl(d.valor)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Relatorios() {
  const [preset, setPreset] = useState('30d')
  const [custom, setCustom] = useState({ inicio: '', fim: '' })
  const [filtros, setFiltros] = useState({ pagamento: 'todos', status: 'todos', tipo: 'todos' })
  const [rep, setRep] = useState(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      let inicio, fim
      if (preset === 'custom') { inicio = custom.inicio ? new Date(custom.inicio) : null; fim = custom.fim ? new Date(custom.fim) : null }
      else { const [a, b] = presetRange(preset); inicio = a; fim = b }
      const qs = new URLSearchParams()
      if (inicio) qs.set('inicio', inicio.toISOString())
      if (fim) qs.set('fim', fim.toISOString())
      for (const k of ['pagamento', 'status', 'tipo']) if (filtros[k] && filtros[k] !== 'todos') qs.set(k, filtros[k])
      setRep(await api(`/financeiro/relatorio?${qs.toString()}`))
    } catch (e) { toast.error(e.message) } finally { setLoading(false) }
  }, [preset, custom, filtros])
  useEffect(() => { load() }, [load])
  const exportCsv = () => {
    if (!rep) return
    const rows = []
    if (rep.cmv && rep.cmv.cmv_percent !== null) {
      // Resumo de custo antes da tabela: e o que o contador procura primeiro.
      rows.push(['Resumo de custo'])
      rows.push(['Custo da mercadoria', String(rep.cmv.custo_total).replace('.', ',')])
      rows.push(['Receita com custo apurado', String(rep.cmv.receita_com_custo).replace('.', ',')])
      rows.push(['Lucro bruto', String(rep.cmv.lucro_bruto).replace('.', ',')])
      rows.push(['CMV %', String(rep.cmv.cmv_percent).replace('.', ',')])
      rows.push(['Cobertura %', String(rep.cmv.cobertura_percent ?? 0).replace('.', ',')])
      rows.push([])
    }
    if (rep.dre) {
      const d = rep.dre
      rows.push(['DRE'])
      rows.push(['Receita', String(d.receita_total).replace('.', ',')])
      rows.push(['(-) Custo da mercadoria', String(d.custo_mercadoria).replace('.', ',')])
      rows.push(['= Lucro bruto', String(d.lucro_bruto).replace('.', ',')])
      rows.push(['(-) Despesas fixas', String(d.despesas_fixas).replace('.', ',')])
      rows.push(['(-) Despesas variáveis', String(d.despesas_variaveis).replace('.', ',')])
      rows.push(['(-) Despesas não classificadas', String(d.despesas_nao_classificadas).replace('.', ',')])
      rows.push(['= Lucro líquido', String(d.lucro_liquido).replace('.', ',')])
      rows.push(['Margem líquida %', String(d.margem_liquida_percent ?? '').replace('.', ',')])
      rows.push(['Ponto de equilíbrio (mensal)', d.ponto_equilibrio !== null ? String(d.ponto_equilibrio).replace('.', ',') : 'nao calculavel'])
      rows.push([])
      if (rep.despesas_por_categoria?.length) {
        rows.push(['Despesas por categoria'])
        rows.push(['Categoria', 'Natureza', 'Valor'])
        for (const c of rep.despesas_por_categoria) {
          rows.push([c.categoria, c.natureza ?? 'nao classificada', String(c.valor).replace('.', ',')])
        }
        rows.push([])
      }
    }
    rows.push(['Data', 'Pedido', 'Cliente', 'Pagamento', 'Valor', 'Status', 'Origem'])
    for (const r of rep.tabela) {
      rows.push([new Date(r.data).toLocaleString('pt-BR'), r.numero, r.cliente, r.pagamento, String(r.valor).replace('.', ','), r.status, r.origem])
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '')}"`).join(';')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `relatorio-${Date.now()}.csv`; a.click()
  }
  const k = rep?.kpis
  const maxForma = Math.max(1, ...(rep?.porFormaPagamento || []).map((f) => f.valor))
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <div className="space-y-1"><Label className="text-xs">Período</Label>
          <Select value={preset} onValueChange={setPreset}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent>{REL_PRESETS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select>
        </div>
        {preset === 'custom' && (
          <>
            <div className="space-y-1"><Label className="text-xs">Início</Label><Input type="date" className="w-40" value={custom.inicio} onChange={(e) => setCustom({ ...custom, inicio: e.target.value })} /></div>
            <div className="space-y-1"><Label className="text-xs">Fim</Label><Input type="date" className="w-40" value={custom.fim} onChange={(e) => setCustom({ ...custom, fim: e.target.value })} /></div>
          </>
        )}
        <div className="space-y-1"><Label className="text-xs">Pagamento</Label><Select value={filtros.pagamento} onValueChange={(v) => setFiltros({ ...filtros, pagamento: v })}><SelectTrigger className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="pix">Pix</SelectItem><SelectItem value="cartao">Cartão</SelectItem><SelectItem value="dinheiro">Dinheiro</SelectItem></SelectContent></Select></div>
        <div className="space-y-1"><Label className="text-xs">Status pedido</Label><Select value={filtros.status} onValueChange={(v) => setFiltros({ ...filtros, status: v })}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="novo">Novo</SelectItem><SelectItem value="em_preparacao">Em preparação</SelectItem><SelectItem value="pronto">Pronto</SelectItem><SelectItem value="saiu">Saiu p/ entrega</SelectItem><SelectItem value="entregue">Entregue</SelectItem><SelectItem value="cancelado">Cancelado</SelectItem></SelectContent></Select></div>
        <div className="space-y-1"><Label className="text-xs">Tipo</Label><Select value={filtros.tipo} onValueChange={(v) => setFiltros({ ...filtros, tipo: v })}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="balcao">Balcão</SelectItem><SelectItem value="delivery">Delivery</SelectItem><SelectItem value="retirada">Retirada</SelectItem><SelectItem value="mesa">Mesa</SelectItem></SelectContent></Select></div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" onClick={exportCsv}>CSV</Button>
          <Button variant="outline" onClick={() => window.print()}>PDF</Button>
        </div>
      </div>
      {loading || !rep ? <Empty>Gerando relatório…</Empty> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={DollarSign} label="Faturamento bruto" value={brl(k.faturamento_bruto)} tone="emerald" />
            <Stat icon={Wallet} label="Faturamento líquido" value={brl(k.faturamento_liquido)} tone="primary" />
            <Stat icon={ShoppingBag} label="Total de pedidos" value={k.total_pedidos} tone="violet" />
            <Stat icon={TrendingUp} label="Ticket médio" value={brl(k.ticket_medio)} tone="amber" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={TrendingUp} label="Receitas" value={brl(k.receitas)} tone="emerald" />
            <Stat icon={TrendingDown} label="Despesas" value={brl(k.despesas)} tone="amber" />
            <Stat icon={CheckCircle2} label="Recebidos" value={brl(k.recebidos)} tone="emerald" />
            <Stat icon={Clock} label="Pendentes / Cancelados" value={`${brl(k.pendentes)} / ${brl(k.cancelados_reembolsados)}`} tone="amber" />
          </div>
          {rep.cmv && rep.cmv.cmv_percent !== null && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat icon={TrendingUp} label="Lucro bruto" value={brl(rep.cmv.lucro_bruto)} tone="emerald" />
              <Stat icon={TrendingDown} label="Custo da mercadoria" value={brl(rep.cmv.custo_total)} tone="amber" />
              <Stat icon={DollarSign} label="CMV" value={`${rep.cmv.cmv_percent.toFixed(1).replace('.', ',')}%`} hint="referência do setor: 28–35%" tone="violet" />
              <Stat icon={CheckCircle2} label="Cobertura de custo" value={`${(rep.cmv.cobertura_percent ?? 0).toFixed(0)}%`} hint="quanto do faturamento tem custo apurado" tone="primary" />
            </div>
          )}
          {rep.dre && <DreCard dre={rep.dre} despesasPorCategoria={rep.despesas_por_categoria} coberturaCmv={rep.cmv?.cobertura_percent} />}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base">Faturamento por dia</CardTitle></CardHeader><CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={rep.serie} margin={{ left: -18, right: 8, top: 8 }}>
                <defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} /><stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="dia" tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                <YAxis tickLine={false} axisLine={false} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                <RTooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }} formatter={(v) => brl(v)} />
                <Area type="monotone" dataKey="faturamento" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#gr)" />
              </AreaChart></ResponsiveContainer>
            </CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Por forma de pagamento</CardTitle></CardHeader><CardContent className="space-y-3">
              {(rep.porFormaPagamento || []).length === 0 && <Empty>Sem dados</Empty>}
              {(rep.porFormaPagamento || []).map((f) => (
                <div key={f.forma} className="space-y-1"><div className="flex justify-between text-sm"><span className="capitalize">{f.forma}</span><span className="font-medium">{brl(f.valor)}</span></div><div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${(f.valor / maxForma) * 100}%` }} /></div></div>
              ))}
            </CardContent></Card>
          </div>
          <Card><CardHeader><CardTitle className="text-base">Detalhamento ({rep.tabela.length})</CardTitle></CardHeader><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Data</TableHead><TableHead>Pedido</TableHead><TableHead>Cliente</TableHead><TableHead>Pagamento</TableHead><TableHead>Origem</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Valor</TableHead></TableRow></TableHeader>
              <TableBody>
                {rep.tabela.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(r.data)}</TableCell>
                    <TableCell className="font-medium">#{r.numero}</TableCell>
                    <TableCell>{r.cliente}</TableCell>
                    <TableCell className="capitalize">{r.pagamento}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{r.origem}</TableCell>
                    <TableCell><Badge variant="outline" className={STATUS[r.status]?.cls || ''}>{STATUS[r.status]?.label || r.status}</Badge></TableCell>
                    <TableCell className="text-right font-medium">{brl(r.valor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rep.tabela.length === 0 && <Empty>Sem registros no período.</Empty>}
          </CardContent></Card>
        </>
      )}
    </div>
  )
}
function TxDialog({ onClose, onSave }) {
  const [f, setF] = useState({ tipo: 'despesa', categoria: '', natureza: '', descricao: '', valor: '' })
  const [categorias, setCategorias] = useState([])
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))

  useEffect(() => { api('/financeiro/categorias-despesa').then(setCategorias).catch(() => {}) }, [])

  // Trocar de categoria pre-preenche a natureza sugerida — mas so se o dono
  // ainda nao tiver escolhido nada nesta sessao do dialog. Sobrescrever uma
  // escolha manual toda vez que a categoria muda seria irritante, e o dono
  // pode legitimamente discordar do padrao (ver comentario em lib/financeiro.js).
  const [naturezaTocada, setNaturezaTocada] = useState(false)
  const setCategoria = (v) => {
    set('categoria', v)
    if (!naturezaTocada) {
      const sugerida = categorias.find((c) => c.valor === v)?.natureza_sugerida
      set('natureza', sugerida || '')
    }
  }
  const setNatureza = (v) => { setNaturezaTocada(true); set('natureza', v) }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo lançamento</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Tipo</Label><Select value={f.tipo} onValueChange={(v) => set('tipo', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="receita">Receita</SelectItem><SelectItem value="despesa">Despesa</SelectItem></SelectContent></Select></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Categoria</Label>
              {f.tipo === 'despesa' ? (
                <Select value={f.categoria} onValueChange={setCategoria}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    {categorias.filter((c) => c.valor !== 'Estorno').map((c) => (
                      <SelectItem key={c.valor} value={c.valor}>{c.valor}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={f.categoria} onChange={(e) => set('categoria', e.target.value)} placeholder="Ex: Vendas" />
              )}
            </div>
            <div className="space-y-2"><Label>Valor (R$)</Label><Input type="number" step="0.01" value={f.valor} onChange={(e) => set('valor', e.target.value)} /></div>
          </div>
          {f.tipo === 'despesa' && (
            <div className="space-y-2">
              <Label>Natureza</Label>
              <Select value={f.natureza} onValueChange={setNatureza}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixa">Fixa — acontece independente de vender (aluguel, salário)</SelectItem>
                  <SelectItem value="variavel">Variável — só existe porque vendeu (insumo, comissão)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Usada no ponto de equilíbrio do relatório. Sem isso, a despesa ainda entra no total, só fica fora desse cálculo.</p>
            </div>
          )}
          <div className="space-y-2"><Label>Descrição</Label><Input value={f.descricao} onChange={(e) => set('descricao', e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={() => onSave(f)}>Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ USUÁRIOS ============================ */
function Usuarios({ roles }) {
  const [list, setList] = useState([])
  const [dlg, setDlg] = useState(null)
  const load = useCallback(() => api('/usuarios').then(setList).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const save = async (d) => { try { if (d.id) await api(`/usuarios/${d.id}`, { method: 'PUT', body: d }); else await api('/usuarios', { method: 'POST', body: d }); toast.success('Usuário salvo'); setDlg(null); load() } catch (e) { toast.error(e.message) } }
  const del = async (id) => { try { await api(`/usuarios/${id}`, { method: 'DELETE' }); toast.success('Removido'); load() } catch (e) { toast.error(e.message) } }
  return (
    <div className="space-y-6">
      <PageHeader title="Usuários & Papéis" description="Gerencie a equipe e os níveis de acesso (RBAC)." action={<Button onClick={() => setDlg({ nome: '', email: '', senha: '', papel: 'ATENDENTE' })}><Plus className="h-4 w-4 mr-1" />Novo usuário</Button>} />
      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>E-mail</TableHead><TableHead>Papel</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader>
          <TableBody>
            {list.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.nome}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell><Badge variant="secondary">{roles?.[u.papel]?.label || u.papel}</Badge></TableCell>
                <TableCell><Badge variant="outline" className={u.ativo ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/10' : 'text-muted-foreground'}>{u.ativo ? 'Ativo' : 'Inativo'}</Badge></TableCell>
                <TableCell className="text-right">
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setDlg({ ...u, senha: '' })}><Pencil className="h-4 w-4 mr-2" />Editar</DropdownMenuItem><DropdownMenuItem className="text-destructive" onClick={() => del(u.id)}><Trash2 className="h-4 w-4 mr-2" />Remover</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>
      {dlg && <UsuarioDialog data={dlg} roles={roles} onClose={() => setDlg(null)} onSave={save} />}
    </div>
  )
}
function UsuarioDialog({ data, roles, onClose, onSave }) {
  const [f, setF] = useState({ ...data })
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>{f.id ? 'Editar usuário' : 'Novo usuário'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Nome</Label><Input value={f.nome} onChange={(e) => set('nome', e.target.value)} /></div>
          <div className="space-y-2"><Label>E-mail</Label><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} disabled={!!f.id} /></div>
          <div className="space-y-2"><Label>Senha {f.id && <span className="text-muted-foreground text-xs">(deixe em branco para manter)</span>}</Label><Input type="password" value={f.senha} onChange={(e) => set('senha', e.target.value)} /></div>
          <div className="space-y-2"><Label>Papel</Label><Select value={f.papel} onValueChange={(v) => set('papel', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(roles || {}).map(([k, r]) => <SelectItem key={k} value={k}>{r.label}</SelectItem>)}</SelectContent></Select></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={() => onSave(f)}>Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ EMPRESA (config) ============================ */
/**
 * Aba "Modulos" — interruptores que realmente ligam e desligam o modulo.
 *
 * Ate 2026-08-18 esta aba mostrava badges "Ativo"/"Em breve" que nao faziam
 * nada: as flags existiam no banco e nenhum endpoint as lia. Agora o
 * interruptor chama PUT /modulos/:chave, o servidor devolve 403 nas rotas do
 * modulo desligado, e o item some da navegacao.
 *
 * Os modulos sem implementacao continuam como badge, sem interruptor. Dar um
 * botao que promete ligar algo inexistente reproduziria exatamente a mentira
 * que este trabalho veio remover.
 */
function ModulosTab({ reload }) {
  const [dados, setDados] = useState(null)
  const [salvando, setSalvando] = useState(null)

  const load = useCallback(async () => {
    try { setDados(await api('/modulos')) } catch (e) { toast.error(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const alternar = async (chave, ativo) => {
    setSalvando(chave)
    try {
      await api(`/modulos/${chave}`, { method: 'PUT', body: { ativo } })
      toast.success(ativo ? 'Modulo ativado' : 'Modulo desativado')
      await load()
      // Recarrega o /auth/me: a navegacao e os cards da tela inteira dependem
      // do `modulos` que vem de la, entao sem isso a sidebar so mudaria no
      // proximo F5.
      reload?.()
    } catch (e) {
      toast.error(e.message)
    } finally { setSalvando(null) }
  }

  if (!dados) return <Empty>Carregando…</Empty>
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Modulos do seu plano</CardTitle>
        <CardDescription>Desligar um modulo esconde as telas e bloqueia o acesso no servidor. Os dados continuam salvos e voltam ao religar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {dados.disponiveis.map((m) => (
          <div key={m.chave} className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{m.label}</div>
              <div className="text-xs text-muted-foreground">{m.descricao}</div>
            </div>
            <Switch checked={m.ativo} disabled={salvando === m.chave} onCheckedChange={(v) => alternar(m.chave, v)} />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function Empresa({ reload }) {
  const [f, setF] = useState(null)
  useEffect(() => { api('/empresa').then(setF).catch((e) => toast.error(e.message)) }, [])

  /* --- DELIVERY: entregadores e configuracao --- */
  const [entregadores, setEntregadores] = useState([])
  const [taxaPadrao, setTaxaPadrao] = useState('')
  const [tempoEstimadoPadrao, setTempoEstimadoPadrao] = useState('')
  const [novoEntregador, setNovoEntregador] = useState({ nome: '', telefone: '' })

  useEffect(() => {
    if (f) {
      // Carregar configuracoes de delivery do estado da empresa
      const deliveryConfig = f.config?.delivery || {}
      setTaxaPadrao(deliveryConfig.taxa_padrao || '')
      setTempoEstimadoPadrao(deliveryConfig.tempo_estimado_min || '')
      // Carregar lista de entregadores
      api('/entregadores').then(setEntregadores).catch((e) => console.error('Falha ao carregar entregadores:', e.message))
    }
  }, [f])

  const handleAdicionarEntregador = async () => {
    if (!novoEntregador.nome.trim()) return toast.error('Informe o nome do entregador')
    try {
      const entregador = await api('/entregadores', { method: 'POST', body: novoEntregador })
      setEntregadores((s) => [entregador, ...s])
      setNovoEntregador({ nome: '', telefone: '' })
      toast.success('Entregador adicionado')
    } catch (e) { toast.error(e.message) }
  }

  const handleAtivarDesativarEntregador = async (id, ativoAtual) => {
    try {
      await api(`/entregadores/${id}`, { method: 'PUT', body: { ativo: !ativoAtual } })
      setEntregadores((s) => s.map((e) => e.id === id ? { ...e, ativo: !ativoAtual } : e))
      toast.success(ativoAtual ? 'Entregador desativado' : 'Entregador ativado')
    } catch (e) { toast.error(e.message) }
  }

  const handleSalvarConfigDelivery = async () => {
    try {
      await api('/empresa', {
        method: 'PUT',
        body: {
          config: {
            delivery: {
              taxa_padrao: taxaPadrao ? Number(taxaPadrao) : null,
              tempo_estimado_min: tempoEstimadoPadrao ? Number(tempoEstimadoPadrao) : null
            }
          }
        }
      })
      toast.success('Configuracao de delivery salva')
      reload?.()
    } catch (e) { toast.error(e.message) }
  }

  /* --- KDS: links tokenizados para a TV/tablet da cozinha --- */
  const [tokens, setTokens] = useState([])
  const carregarTokens = () => api('/kds/tokens').then(setTokens).catch((e) => toast.error(e.message))
  useEffect(() => { carregarTokens() }, [])
  const gerarToken = async (modo) => {
    try {
      const t = await api('/kds/tokens', { method: 'POST', body: { modo } })
      setTokens((s) => [t, ...s])
      toast.success('Link gerado')
    } catch (e) { toast.error(e.message) }
  }
  const revogarToken = async (id) => {
    try { await api(`/kds/tokens/${id}`, { method: 'DELETE' }); carregarTokens(); toast.success('Link revogado') } catch (e) { toast.error(e.message) }
  }
  const linkDoToken = (token) => `${window.location.origin}/?kds_tv=${token}`
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const setAp = (k, v) => setF((s) => ({ ...s, config: { ...s.config, appearance: { ...(s.config?.appearance || {}), [k]: v } } }))
  const setMet = (k, v) => setF((s) => ({ ...s, config: { ...s.config, pagamentos: { ...(s.config?.pagamentos || {}), metodos: { ...(s.config?.pagamentos?.metodos || {}), [k]: v } } } }))
  const saveDados = async () => { try { await api('/empresa', { method: 'PUT', body: { nome: f.nome, nome_comercial: f.nome_comercial, cnpj: f.cnpj, telefone: f.telefone, whatsapp: f.whatsapp, email: f.email, endereco: f.endereco, horario_funcionamento: f.horario_funcionamento, moeda: f.moeda } }); toast.success('Dados atualizados'); reload?.() } catch (e) { toast.error(e.message) } }
  const saveApp = async () => { try { await api('/empresa', { method: 'PUT', body: { config: { appearance: f.config?.appearance } } }); toast.success('Aparencia atualizada'); reload?.() } catch (e) { toast.error(e.message) } }

  /* --- Logo: upload de arquivo (multipart), nao URL --- */
  const [enviandoLogo, setEnviandoLogo] = useState(false)
  const inputLogoRef = useRef(null)
  const MAX_LOGO_MB = 1

  const enviarLogo = async (file) => {
    if (!file) return
    // Valida no cliente para dar retorno imediato; o servidor revalida sempre.
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      toast.error('Formato nao suportado. Use PNG, JPG, WEBP ou SVG.'); return
    }
    if (file.size > MAX_LOGO_MB * 1024 * 1024) {
      toast.error(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Limite: ${MAX_LOGO_MB} MB.`); return
    }
    setEnviandoLogo(true)
    try {
      const fd = new FormData()
      fd.append('arquivo', file)
      const res = await fetch('/api/empresa/logo', { method: 'POST', headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Falha ao enviar a logo')
      setF((s) => ({ ...s, logo: data.logo }))
      toast.success('Logo atualizada')
      reload?.()
    } catch (e) { toast.error(e.message) } finally {
      setEnviandoLogo(false)
      if (inputLogoRef.current) inputLogoRef.current.value = '' // permite reenviar o mesmo arquivo
    }
  }

  const removerLogo = async () => {
    setEnviandoLogo(true)
    try {
      await api('/empresa/logo', { method: 'DELETE' })
      setF((s) => ({ ...s, logo: null }))
      toast.success('Logo removida')
      reload?.()
    } catch (e) { toast.error(e.message) } finally { setEnviandoLogo(false) }
  }

  /* --- Imagem do cardapio: mesmo padrao da logo (upload multipart) --- */
  const [enviandoCardapioImagem, setEnviandoCardapioImagem] = useState(false)
  const inputCardapioImagemRef = useRef(null)
  const MAX_CARDAPIO_IMAGEM_MB = 5

  const enviarCardapioImagem = async (file) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Formato nao suportado. Use PNG, JPG ou WEBP.'); return
    }
    if (file.size > MAX_CARDAPIO_IMAGEM_MB * 1024 * 1024) {
      toast.error(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Limite: ${MAX_CARDAPIO_IMAGEM_MB} MB.`); return
    }
    setEnviandoCardapioImagem(true)
    try {
      const fd = new FormData()
      fd.append('arquivo', file)
      const res = await fetch('/api/empresa/cardapio-imagem', { method: 'POST', headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) }, body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Falha ao enviar a imagem')
      setF((s) => ({ ...s, cardapio_imagem_url: data.cardapio_imagem_url }))
      toast.success('Imagem do cardapio atualizada')
      reload?.()
    } catch (e) { toast.error(e.message) } finally {
      setEnviandoCardapioImagem(false)
      if (inputCardapioImagemRef.current) inputCardapioImagemRef.current.value = ''
    }
  }

  const removerCardapioImagem = async () => {
    setEnviandoCardapioImagem(true)
    try {
      await api('/empresa/cardapio-imagem', { method: 'DELETE' })
      setF((s) => ({ ...s, cardapio_imagem_url: null }))
      toast.success('Imagem do cardapio removida')
      reload?.()
    } catch (e) { toast.error(e.message) } finally { setEnviandoCardapioImagem(false) }
  }

  const savePag = async () => { try { await api('/empresa', { method: 'PUT', body: { config: { pagamentos: f.config?.pagamentos } } }); toast.success('Pagamentos atualizados'); reload?.() } catch (e) { toast.error(e.message) } }
  if (!f) return <Empty>Carregando…</Empty>
  const ap = f.config?.appearance || {}
  const met = f.config?.pagamentos?.metodos || {}
  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Configuracoes" description="Personalize os dados, a identidade visual e as formas de pagamento." />
      <Tabs defaultValue="dados">
        <TabsList><TabsTrigger value="dados">Empresa</TabsTrigger><TabsTrigger value="aparencia">Aparencia</TabsTrigger><TabsTrigger value="pagamentos">Pagamentos</TabsTrigger><TabsTrigger value="modulos">Modulos</TabsTrigger><TabsTrigger value="kds">Cozinha (KDS)</TabsTrigger><TabsTrigger value="cardapio">Cardapio Digital</TabsTrigger></TabsList>

        <TabsContent value="dados" className="mt-4 space-y-4">
          <Card><CardHeader><CardTitle className="text-base">Dados da empresa</CardTitle></CardHeader><CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Razao social</Label><Input value={f.nome || ''} onChange={set('nome')} /></div>
              <div className="space-y-2"><Label>Nome comercial</Label><Input value={f.nome_comercial || ''} onChange={set('nome_comercial')} /></div>
              <div className="space-y-2"><Label>CNPJ</Label><Input value={f.cnpj || ''} onChange={set('cnpj')} /></div>
              <div className="space-y-2"><Label>Telefone</Label><Input value={f.telefone || ''} onChange={set('telefone')} /></div>
              <div className="space-y-2"><Label>WhatsApp</Label><Input value={f.whatsapp || ''} onChange={set('whatsapp')} /></div>
              <div className="space-y-2"><Label>E-mail</Label><Input value={f.email || ''} onChange={set('email')} /></div>
            </div>
            <div className="space-y-2"><Label>Endereco</Label><Input value={f.endereco || ''} onChange={set('endereco')} /></div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Horario de funcionamento</Label><Input value={f.horario_funcionamento || ''} onChange={set('horario_funcionamento')} placeholder="Seg-Dom 11h-23h" /></div>
              <div className="space-y-2"><Label>Moeda</Label><Input value={f.moeda || 'BRL'} onChange={set('moeda')} /></div>
            </div>
            <div className="text-xs text-muted-foreground">Slug: <code className="bg-muted px-1.5 py-0.5 rounded">{f.slug}</code> · Plano: <Badge variant="secondary">{f.plano}</Badge></div>
            <Button onClick={saveDados}>Salvar dados</Button>
          </CardContent></Card>

          <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" />Delivery</CardTitle></CardHeader><CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Taxa padrao (R$)</Label><Input type="number" min="0" step="0.01" value={taxaPadrao} onChange={(e) => setTaxaPadrao(e.target.value)} placeholder="0,00" /></div>
              <div className="space-y-2"><Label>Tempo estimado (min)</Label><Input type="number" min="0" value={tempoEstimadoPadrao} onChange={(e) => setTempoEstimadoPadrao(e.target.value)} placeholder="30" /></div>
            </div>
            <Button onClick={handleSalvarConfigDelivery}>Salvar configuracao</Button>

            <Separator />

            <div className="space-y-3">
              <h3 className="font-semibold text-sm">Entregadores</h3>
              <div className="space-y-2 max-h-48 overflow-auto ros-scroll">
                {entregadores.length === 0 && <p className="text-sm text-muted-foreground">Nenhum entregador cadastrado.</p>}
                {entregadores.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{e.nome}</div>
                      {e.telefone && <div className="text-xs text-muted-foreground">{e.telefone}</div>}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className={e.ativo ? 'text-emerald-500 border-emerald-500/50 hover:bg-emerald-500/10' : 'text-muted-foreground'}
                      onClick={() => handleAtivarDesativarEntregador(e.id, e.ativo)}
                    >
                      {e.ativo ? 'Ativo' : 'Inativo'}
                    </Button>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Adicionar entregador</h4>
                <div className="grid sm:grid-cols-2 gap-2">
                  <Input
                    placeholder="Nome"
                    value={novoEntregador.nome}
                    onChange={(e) => setNovoEntregador({ ...novoEntregador, nome: e.target.value })}
                  />
                  <Input
                    placeholder="Telefone"
                    value={novoEntregador.telefone}
                    onChange={(e) => setNovoEntregador({ ...novoEntregador, telefone: e.target.value })}
                  />
                </div>
                <Button onClick={handleAdicionarEntregador} className="w-full"><Plus className="h-4 w-4 mr-1" />Adicionar</Button>
              </div>
            </div>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="aparencia" className="mt-4">
          <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><Palette className="h-4 w-4" />Identidade visual</CardTitle><CardDescription>A plataforma passa a usar o nome e as cores da sua empresa.</CardDescription></CardHeader><CardContent className="space-y-4">
            <div className="space-y-2"><Label>Nome exibido</Label><Input value={ap.nome_exibido || ''} onChange={(e) => setAp('nome_exibido', e.target.value)} placeholder="Nome que aparece no painel" /></div>
            <div className="space-y-2">
              <Label>Logo da empresa</Label>
              <div className="flex items-center gap-4 rounded-lg border p-3">
                <div className="h-16 w-16 shrink-0 rounded-lg border bg-muted grid place-items-center overflow-hidden">
                  {f.logo
                    ? <img src={f.logo} alt="Logo da empresa" className="h-full w-full object-contain" />
                    : <ChefHat className="h-6 w-6 text-muted-foreground" aria-hidden="true" />}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    ref={inputLogoRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => enviarLogo(e.target.files?.[0])}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={enviandoLogo} onClick={() => inputLogoRef.current?.click()}>
                      {enviandoLogo
                        ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Enviando…</>
                        : <>{f.logo ? 'Trocar logo' : 'Enviar logo'}</>}
                    </Button>
                    {f.logo && (
                      <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={enviandoLogo} onClick={removerLogo}>
                        <Trash2 className="h-4 w-4 mr-2" />Remover
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">PNG, JPG, WEBP ou SVG · ate {MAX_LOGO_MB} MB. Aparece no menu lateral.</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Cor principal</Label><div className="flex gap-2"><input type="color" className="h-9 w-12 rounded border bg-transparent" value={ap.cor_principal || '#4f46e5'} onChange={(e) => setAp('cor_principal', e.target.value)} /><Input value={ap.cor_principal || '#4f46e5'} onChange={(e) => setAp('cor_principal', e.target.value)} /></div></div>
              <div className="space-y-2"><Label>Cor secundaria</Label><div className="flex gap-2"><input type="color" className="h-9 w-12 rounded border bg-transparent" value={ap.cor_secundaria || '#7c3aed'} onChange={(e) => setAp('cor_secundaria', e.target.value)} /><Input value={ap.cor_secundaria || '#7c3aed'} onChange={(e) => setAp('cor_secundaria', e.target.value)} /></div></div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3"><div><Label>Tema padrao</Label><p className="text-xs text-muted-foreground">Claro ou escuro ao entrar.</p></div>
              <Select value={ap.tema || 'dark'} onValueChange={(v) => setAp('tema', v)}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dark">Escuro</SelectItem><SelectItem value="light">Claro</SelectItem></SelectContent></Select>
            </div>
            <Button onClick={saveApp}>Salvar aparencia</Button>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="pagamentos" className="mt-4">
          <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><CreditCard className="h-4 w-4" />Formas de pagamento</CardTitle><CardDescription>Habilite os metodos aceitos pelo estabelecimento.</CardDescription></CardHeader><CardContent className="space-y-3">
            {[['dinheiro', 'Dinheiro'], ['pix', 'Pix'], ['cartao_debito', 'Cartao de debito'], ['cartao_credito', 'Cartao de credito']].map(([k, label]) => (
              <div key={k} className="flex items-center justify-between rounded-lg border p-3"><span className="text-sm">{label}</span><Switch checked={met[k] !== false} onCheckedChange={(v) => setMet(k, v)} /></div>
            ))}
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">Gateways online (Pix automatico) sao configurados em <span className="font-medium text-foreground">Integracoes</span>. Arquitetura preparada para Mercado Pago, Asaas e Stripe.</div>
            <Button onClick={savePag}>Salvar pagamentos</Button>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="modulos" className="mt-4">
          <ModulosTab reload={reload} />
        </TabsContent>

        <TabsContent value="kds" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tela de cozinha (KDS)</CardTitle>
              <CardDescription>
                Links para a TV/tablet da cozinha ver os pedidos pendentes. Somente
                leitura roda numa TV comum; com toque precisa de tela sensivel ao
                toque para o cozinheiro marcar como pronto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => gerarToken('leitura')}>Gerar link — somente leitura</Button>
                <Button variant="outline" onClick={() => gerarToken('toque')}>Gerar link — com toque</Button>
              </div>
              <div className="space-y-2">
                {tokens.length === 0 && <p className="text-sm text-muted-foreground">Nenhum link gerado ainda.</p>}
                {tokens.filter((t) => !t.revogado_em).map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 border rounded-lg p-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><Badge variant="secondary">{t.modo === 'toque' ? 'Com toque' : 'Somente leitura'}</Badge></div>
                      <div className="truncate text-xs text-muted-foreground mt-1">{linkDoToken(t.token)}</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(linkDoToken(t.token)); toast.success('Link copiado') }}>Copiar</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revogarToken(t.id)}>Revogar</Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cardapio" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Imagem do cardápio</CardTitle>
              <CardDescription>
                Suba uma foto ou pôster do seu cardápio. Quem escanear o QR da mesa —
                ou receber o link pelo delivery — vê essa imagem direto, sem precisar
                que os produtos estejam todos cadastrados no sistema.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-4 rounded-lg border p-3">
                <div className="h-24 w-20 shrink-0 rounded-lg border bg-muted grid place-items-center overflow-hidden">
                  {f.cardapio_imagem_url
                    ? <img src={f.cardapio_imagem_url} alt="Imagem do cardápio" className="h-full w-full object-cover" />
                    : <UtensilsCrossed className="h-6 w-6 text-muted-foreground" aria-hidden="true" />}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    ref={inputCardapioImagemRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => enviarCardapioImagem(e.target.files?.[0])}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={enviandoCardapioImagem} onClick={() => inputCardapioImagemRef.current?.click()}>
                      {enviandoCardapioImagem
                        ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Enviando…</>
                        : <>{f.cardapio_imagem_url ? 'Trocar imagem' : 'Enviar imagem'}</>}
                    </Button>
                    {f.cardapio_imagem_url && (
                      <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={enviandoCardapioImagem} onClick={removerCardapioImagem}>
                        <Trash2 className="h-4 w-4 mr-2" />Remover
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">PNG, JPG ou WEBP · até {MAX_CARDAPIO_IMAGEM_MB} MB.</p>
                  <p className="text-xs text-muted-foreground">
                    Itens marcados como "Em falta" em <span className="font-medium text-foreground">Cardápio</span> aparecem
                    em destaque acima da imagem, para o cliente saber o que não pedir hoje — sem precisar editar a imagem.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Link e QR Code</CardTitle>
              <CardDescription>
                Mesmo link para a mesa (QR) e para delivery (encaminhar manualmente). Mostra a imagem
                acima quando cadastrada, ou a lista de produtos quando não.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <h3 className="font-semibold mb-2">Link Público</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?cardapio=${f.slug}`}
                    className="flex-1 border rounded px-3 py-2 text-sm bg-muted"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/?cardapio=${f.slug}`
                      navigator.clipboard.writeText(link)
                      toast.success('Link copiado!')
                    }}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copiar
                  </Button>
                </div>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Código QR</h3>
                <div className="flex flex-col items-center gap-3">
                  <div className="border rounded p-2 bg-white">
                    <QRCodeSVG
                      value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?cardapio=${f.slug}`}
                      size={200}
                      level="H"
                      includeMargin={true}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const canvas = document.querySelector('canvas')
                      if (!canvas) return
                      const link = document.createElement('a')
                      link.href = canvas.toDataURL('image/png')
                      link.download = `cardapio-${f.slug}.png`
                      link.click()
                    }}
                  >
                    Baixar QR
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ============================ INTEGRAÇÕES ============================ */
function Integracoes() {
  const [data, setData] = useState(null)
  const [testing, setTesting] = useState('')
  const load = useCallback(() => api('/integracoes').then(setData).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const [ev, setEv] = useState({ serverUrl: '', apiKey: '', instance: 'restaurant-os', webhookSecret: '' })
  const [n8, setN8] = useState({ webhookUrl: '', apiKey: '' })
  // apiKey/webhookSecret nunca voltam do GET (mascarados no backend) — so
  // serverUrl/instance sao pre-preenchidos. Mesmo espirito do Mercado Pago
  // abaixo: campo de segredo comeca vazio, com placeholder "mantido".
  useEffect(() => { if (data) { setEv((s) => ({ ...s, serverUrl: data.evolution?.config?.serverUrl ?? s.serverUrl, instance: data.evolution?.config?.instance || s.instance || 'restaurant-os' })); setN8({ ...n8, ...(data.n8n?.config || {}) }) } }, [data])
  const saveEv = async () => {
    try {
      // O backend gera o webhookSecret sozinho na primeira vez e devolve em
      // texto puro so nesta resposta — precisa ficar visivel na tela para o
      // dono copiar para a configuracao de webhook da Evolution API, porque
      // o proximo GET (load() logo abaixo) ja vem mascarado.
      const r = await api('/integracoes/evolution', { method: 'PUT', body: ev })
      setEv((s) => ({ ...s, apiKey: '', webhookSecret: r?.config?.webhookSecret || s.webhookSecret }))
      toast.success('Evolution API salva')
      load()
    } catch (e) { toast.error(e.message) }
  }
  const saveN8 = async () => { try { await api('/integracoes/n8n', { method: 'PUT', body: n8 }); toast.success('n8n salvo'); load() } catch (e) { toast.error(e.message) } }
  const testEv = async () => { setTesting('ev'); try { const r = await api('/integracoes/evolution/testar', { method: 'POST' }); r.connected ? toast.success('WhatsApp conectado!') : toast.warning(r.message || `Estado: ${r.state}`) } catch (e) { toast.error(e.message) } finally { setTesting('') } }
  const testN8 = async () => { setTesting('n8'); try { const r = await api('/integracoes/n8n/testar', { method: 'POST' }); r.connected ? toast.success('Webhook n8n respondeu!') : toast.warning(r.message || 'Sem resposta') } catch (e) { toast.error(e.message) } finally { setTesting('') } }
  const [mp, setMp] = useState({ mode: 'sandbox', accessToken: '', webhookSecret: '' })
  useEffect(() => { if (data?.mercadopago?.config) setMp((s) => ({ ...s, mode: data.mercadopago.config.mode || 'sandbox' })) }, [data])
  const saveMp = async () => { try { await api('/integracoes/mercadopago', { method: 'PUT', body: mp }); toast.success('Mercado Pago salvo'); setMp((s) => ({ ...s, accessToken: '', webhookSecret: '' })); load() } catch (e) { toast.error(e.message) } }
  if (!data) return <Empty>Carregando…</Empty>
  const StatusBadge = ({ ok }) => <Badge variant="outline" className={ok ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/10' : 'text-muted-foreground'}>{ok ? 'Configurado' : 'Não configurado'}</Badge>
  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Integrações" description="Conecte WhatsApp (Evolution API) e automações (n8n). Basta preencher as credenciais." />
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-lg bg-emerald-500/10 text-emerald-500 grid place-items-center"><MessageSquare className="h-5 w-5" /></div><div><CardTitle className="text-base">Evolution API — WhatsApp</CardTitle><CardDescription>Envio de mensagens e status da instância.</CardDescription></div></div>
          <StatusBadge ok={data.evolution?.status === 'configurado'} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label>Server URL</Label><Input value={ev.serverUrl} onChange={(e) => setEv({ ...ev, serverUrl: e.target.value })} placeholder="https://evolution.seudominio.com" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>API Key</Label><Input type="password" value={ev.apiKey} onChange={(e) => setEv({ ...ev, apiKey: e.target.value })} placeholder={data.evolution?.config?.hasApiKey ? '•••• (mantido — preencha para trocar)' : '••••••••'} /></div>
            <div className="space-y-2"><Label>Instância</Label><Input value={ev.instance} onChange={(e) => setEv({ ...ev, instance: e.target.value })} /></div>
          </div>
          <div className="space-y-2">
            <Label>Segredo do webhook</Label>
            <Input value={ev.webhookSecret} onChange={(e) => setEv({ ...ev, webhookSecret: e.target.value })} placeholder={data.evolution?.config?.hasWebhookSecret ? '•••• (gerado automaticamente — copie para a Evolution API)' : 'gerado ao salvar'} />
          </div>
          <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
            URL do webhook (configurar na Evolution API, evento <code className="bg-background px-1.5 py-0.5 rounded">messages.upsert</code>):{' '}
            <code className="bg-background px-1.5 py-0.5 rounded">/api/whatsapp/webhook?tenant=SUA_EMPRESA&amp;secret=SEU_SEGREDO</code>.
            Sem o segredo correto, o webhook e recusado — evita que outra empresa injete mensagem falsa na sua caixa de atendimento.
          </div>
          <div className="flex gap-2"><Button onClick={saveEv}>Salvar</Button><Button variant="outline" onClick={testEv} disabled={testing === 'ev'}>{testing === 'ev' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Testar conexão</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-lg bg-violet-500/10 text-violet-500 grid place-items-center"><Workflow className="h-5 w-5" /></div><div><CardTitle className="text-base">n8n — Automações</CardTitle><CardDescription>Eventos: order.created, order.status_changed…</CardDescription></div></div>
          <StatusBadge ok={data.n8n?.status === 'configurado'} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label>Webhook URL</Label><Input value={n8.webhookUrl} onChange={(e) => setN8({ ...n8, webhookUrl: e.target.value })} placeholder="https://n8n.seudominio.com/webhook/xxxx" /></div>
          <div className="space-y-2"><Label>API Key (opcional)</Label><Input value={n8.apiKey} onChange={(e) => setN8({ ...n8, apiKey: e.target.value })} placeholder="••••••••" /></div>
          <div className="flex gap-2"><Button onClick={saveN8}>Salvar</Button><Button variant="outline" onClick={testN8} disabled={testing === 'n8'}>{testing === 'n8' && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Testar webhook</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-lg bg-sky-500/10 text-sky-500 grid place-items-center"><CircleDollarSign className="h-5 w-5" /></div><div><CardTitle className="text-base">Mercado Pago — Pagamentos Pix</CardTitle><CardDescription>Access Token fica somente no backend. Webhook validado por assinatura.</CardDescription></div></div>
          <StatusBadge ok={data.mercadopago?.config?.hasAccessToken} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Ambiente</Label><Select value={mp.mode} onValueChange={(v) => setMp({ ...mp, mode: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sandbox">Sandbox (teste)</SelectItem><SelectItem value="production">Producao</SelectItem></SelectContent></Select></div>
            <div className="space-y-2"><Label>Webhook Secret</Label><Input value={mp.webhookSecret} onChange={(e) => setMp({ ...mp, webhookSecret: e.target.value })} placeholder={data.mercadopago?.config?.hasWebhookSecret ? '•••• (mantido)' : 'assinatura'} /></div>
          </div>
          <div className="space-y-2"><Label>Access Token</Label><Input type="password" value={mp.accessToken} onChange={(e) => setMp({ ...mp, accessToken: e.target.value })} placeholder={data.mercadopago?.config?.hasAccessToken ? '•••• (mantido — preencha para trocar)' : 'APP_USR-... ou TEST-...'} /></div>
          <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">URL do webhook: <code className="bg-background px-1.5 py-0.5 rounded">/api/pagamentos/webhook/mercadopago?tenant=SUA_EMPRESA</code>. Suporta Pix (QR Code + Copia e Cola), status por webhook e idempotência.</div>
          <Button onClick={saveMp}>Salvar credenciais</Button>
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================ AUDITORIA ============================ */
function Auditoria() {
  const [list, setList] = useState([])
  useEffect(() => { api('/auditoria').then(setList).catch((e) => toast.error(e.message)) }, [])
  return (
    <div className="space-y-6">
      <PageHeader title="Auditoria" description="Trilha de auditoria de todas as ações realizadas na empresa." />
      <Card><CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Ação</TableHead><TableHead>Entidade</TableHead><TableHead>Usuário</TableHead><TableHead className="text-right">Data</TableHead></TableRow></TableHeader>
          <TableBody>
            {list.map((a) => (
              <TableRow key={a.id}>
                <TableCell><Badge variant="secondary" className="capitalize">{a.acao}</Badge></TableCell>
                <TableCell className="text-muted-foreground capitalize">{a.entidade}</TableCell>
                <TableCell>{a.usuario_nome || '—'}</TableCell>
                <TableCell className="text-right text-muted-foreground text-sm">{fmtDate(a.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {list.length === 0 && <Empty>Nenhum registro.</Empty>}
      </CardContent></Card>
    </div>
  )
}

/* ============================ MESAS / COMANDAS ============================ */
// Resume os itens de uma comanda por estagio de preparo, para o card de Mesas
// mostrar rapidamente o que ainda esta em preparo/aguardando e o que ja foi
// entregue a mesa. Os itens de comanda (ver /kds/pendentes no backend) so tem
// um campo booleano `entregue` — nao ha recebido/em_preparo/pronto distintos
// como no Kanban de Pedidos (STATUS/FLOW), entao o resumo usa 2 estagios reais
// em vez de fabricar uma granularidade que a comanda nao rastreia.
function getOrderStatusSummary(comanda) {
  if (!comanda) return []
  const out = []
  if (comanda.itens_pendentes > 0) out.push({ key: 'pendente', label: 'Em preparo', count: comanda.itens_pendentes, cls: STATUS.em_preparo.cls })
  if (comanda.itens_entregues > 0) out.push({ key: 'entregue', label: 'Entregue', count: comanda.itens_entregues, cls: STATUS.pronto.cls })
  return out
}
function Mesas() {
  const [mesas, setMesas] = useState([])
  const [cfg, setCfg] = useState(false)
  const [abrir, setAbrir] = useState(null) // mesa livre
  const [comandaId, setComandaId] = useState(null)
  const [editar, setEditar] = useState(null) // mesa sendo renomeada
  const load = useCallback(() => api('/mesas').then(setMesas).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const onClickMesa = (m) => { if (m.status === 'livre') setAbrir(m); else if (m.comanda_id) setComandaId(m.comanda_id) }
  const resumo = ['livre', 'ocupada', 'aguardando_pagamento', 'reservada'].map((s) => ({ s, n: mesas.filter((m) => m.status === s).length }))
  return (
    <div className="space-y-6">
      <PageHeader title="Mesas" description="Controle de salao em tempo real. Clique numa mesa para abrir ou gerenciar a comanda." action={<Button variant="outline" onClick={() => setCfg(true)}><Settings className="h-4 w-4 mr-1" />Configurar mesas</Button>} />
      <div className="flex flex-wrap gap-4">
        {resumo.map(({ s, n }) => (
          <div key={s} className="flex items-center gap-2 text-sm"><span className={`h-2.5 w-2.5 rounded-full ${MESA_STATUS[s].dot}`} /><span className="text-muted-foreground">{MESA_STATUS[s].label}</span><span className="font-semibold">{n}</span></div>
        ))}
      </div>
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {mesas.map((m) => {
          const st = MESA_STATUS[m.status] || MESA_STATUS.livre
          return (
            <button key={m.id} onClick={() => onClickMesa(m)} className={`relative text-left rounded-xl border-2 p-4 transition-all hover:shadow-md ${st.cls}`}>
              <button
                type="button"
                title="Renomear mesa"
                onClick={(e) => { e.stopPropagation(); setEditar(m) }}
                className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5"
              ><Pencil className="h-3 w-3" /></button>
              <div className="flex items-center justify-between pr-5">
                <span className="font-bold truncate">{m.nome || `Mesa ${String(m.numero).padStart(2, '0')}`}</span>
                <span className={`h-2.5 w-2.5 rounded-full ${st.dot} shrink-0`} />
              </div>
              <div className={`text-xs mt-1 ${st.text}`}>{st.label}</div>
              <div className="mt-3 min-h-[2.5rem]">
                {m.comanda ? (
                  <div>
                    <div className="text-lg font-bold">{brl(m.comanda.total)}</div>
                    <div className="text-xs text-muted-foreground truncate">{m.comanda.cliente_nome} · {m.comanda.itens_count} itens</div>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><Armchair className="h-3.5 w-3.5" />{m.capacidade} lugares</div>
                )}
              </div>
              {m.comanda && (() => {
                const resumoStatus = getOrderStatusSummary(m.comanda)
                return resumoStatus.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {resumoStatus.map((r) => (
                      <Badge key={r.key} variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${r.cls}`}>{r.count} {r.label}</Badge>
                    ))}
                  </div>
                ) : null
              })()}
            </button>
          )
        })}
        {mesas.length === 0 && <div className="col-span-full"><Empty>Nenhuma mesa configurada. Clique em "Configurar mesas".</Empty></div>}
      </div>
      {cfg && <ConfigurarMesasDialog atual={mesas.length} onClose={() => setCfg(false)} onSaved={() => { setCfg(false); load() }} />}
      {abrir && <AbrirComandaDialog mesa={abrir} onClose={() => setAbrir(null)} onOpened={(cid) => { setAbrir(null); load(); setComandaId(cid) }} />}
      {comandaId && <ComandaDialog comandaId={comandaId} onClose={() => { setComandaId(null); load() }} />}
      {editar && <EditarMesaDialog mesa={editar} onClose={() => setEditar(null)} onSaved={() => { setEditar(null); load() }} />}
    </div>
  )
}
/**
 * Renomeia uma mesa (Feature: nomes customizados - "Mesa 01" -> "Cantinho da
 * Janela", etc). O backend (PUT /mesas/:id) ja aceitava `nome` desde a Fase 4
 * (coluna `mesas.nome text not null`, sempre populada como "Mesa NN" na
 * criacao); so faltava esta UI para o operador customizar. Campo vazio volta
 * ao nome padrao "Mesa NN" (nome nunca fica null no banco).
 */
function EditarMesaDialog({ mesa, onClose, onSaved }) {
  const [nome, setNome] = useState(mesa.nome || '')
  const [saving, setSaving] = useState(false)
  const padrao = `Mesa ${String(mesa.numero).padStart(2, '0')}`
  const save = async () => {
    setSaving(true)
    try {
      const novoNome = nome.trim() || padrao
      await api(`/mesas/${mesa.id}`, { method: 'PUT', body: { nome: novoNome } })
      toast.success('Mesa atualizada')
      onSaved()
    } catch (e) { toast.error(e.message) } finally { setSaving(false) }
  }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Renomear mesa</DialogTitle><DialogDescription>De um nome customizado a mesa (ex: "Janela", "Varanda"). Deixe em branco para usar "{padrao}".</DialogDescription></DialogHeader>
        <div className="space-y-2">
          <Label>Nome da mesa</Label>
          <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder={padrao} maxLength={50} autoFocus />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
function ConfigurarMesasDialog({ atual, onClose, onSaved }) {
  const [quantidade, setQ] = useState(atual || 10)
  const [capacidade, setCap] = useState(4)
  const save = async () => { try { await api('/mesas/configurar', { method: 'POST', body: { quantidade: Number(quantidade), capacidade: Number(capacidade) } }); toast.success('Salao configurado'); onSaved() } catch (e) { toast.error(e.message) } }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Configurar mesas</DialogTitle><DialogDescription>Defina quantas mesas o estabelecimento possui. Mesas ocupadas nunca sao removidas.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2"><Label>Quantidade de mesas</Label><Input type="number" min={0} value={quantidade} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="space-y-2"><Label>Capacidade padrao</Label><Input type="number" min={1} value={capacidade} onChange={(e) => setCap(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={save}>Salvar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
function AbrirComandaDialog({ mesa, onClose, onOpened }) {
  const [cliente_id, setCliente] = useState(null)
  const [pessoas, setPessoas] = useState(2)
  const open = async () => { try { const c = await api(`/mesas/${mesa.id}/abrir`, { method: 'POST', body: { cliente_id, pessoas: Number(pessoas) } }); toast.success('Comanda aberta'); onOpened(c.id) } catch (e) { toast.error(e.message) } }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Abrir {mesa.nome}</DialogTitle><DialogDescription>Inicie o atendimento associando um cliente (opcional).</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <ClientePicker value={cliente_id} onChange={setCliente} />
          <div className="space-y-1"><Label className="text-xs">Numero de pessoas</Label><Input type="number" min={1} value={pessoas} onChange={(e) => setPessoas(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={open}>Abrir comanda</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
function ComandaDialog({ comandaId, onClose }) {
  const [c, setC] = useState(null)
  const [prods, setProds] = useState([])
  const [mesasLivres, setMesasLivres] = useState([])
  const [addOpen, setAddOpen] = useState(false)
  const [obsPendente, setObsPendente] = useState('')
  const [pay, setPay] = useState({ metodo: 'dinheiro', valor: '' })
  const [pix, setPix] = useState(null)
  const [transferOpen, setTransferOpen] = useState(false)
  const load = useCallback(async () => { const d = await api(`/comandas/${comandaId}`); setC(d) }, [comandaId])
  useEffect(() => { load().catch((e) => toast.error(e.message)); api('/produtos').then(setProds).catch(() => {}); api('/mesas').then((m) => setMesasLivres((m || []).filter((x) => x.status === 'livre'))).catch(() => {}) }, [load])
  if (!c) return <Dialog open onOpenChange={onClose}><DialogContent><Empty>Carregando comanda…</Empty></DialogContent></Dialog>
  const addItem = async (p) => { try { const d = await api(`/comandas/${comandaId}/itens`, { method: 'POST', body: { produto_id: p.id, quantidade: 1, observacao: obsPendente } }); setC(d); setObsPendente('') } catch (e) { toast.error(e.message) } }
  const setQty = async (item, q) => { if (q <= 0) { const d = await api(`/comandas/${comandaId}/itens/${item.id}`, { method: 'DELETE' }); setC(d); return } const d = await api(`/comandas/${comandaId}/itens/${item.id}`, { method: 'PUT', body: { quantidade: q } }); setC(d) }
  const updateComanda = async (patch) => { try { const d = await api(`/comandas/${comandaId}`, { method: 'PUT', body: patch }); setC(d) } catch (e) { toast.error(e.message) } }
  const addPay = async () => { if (!pay.valor) return toast.error('Informe o valor'); try { const d = await api(`/comandas/${comandaId}/pagamentos`, { method: 'POST', body: { metodo: pay.metodo, valor: Number(pay.valor) } }); setC(d); setPay({ metodo: 'dinheiro', valor: '' }); toast.success('Pagamento registrado') } catch (e) { toast.error(e.message) } }
  const gerarPix = async () => { try { const r = await api(`/comandas/${comandaId}/pix`, { method: 'POST', body: {} }); setPix(r); toast.success('Pix gerado') } catch (e) { toast.error(e.message) } }
  const transferir = async (mesa_id) => { try { await api(`/comandas/${comandaId}/transferir`, { method: 'POST', body: { mesa_id } }); toast.success('Comanda transferida'); setTransferOpen(false); load() } catch (e) { toast.error(e.message) } }
  const fechar = async () => { try { const r = await api(`/comandas/${comandaId}/fechar`, { method: 'POST', body: {} }); toast.success(`Comanda fechada · Pedido #${r.pedido_numero}`); onClose() } catch (e) { toast.error(e.message) } }
  const porPessoa = c.pessoas > 0 ? c.restante / c.pessoas : c.restante
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-auto ros-scroll">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{c.mesa_nome}<Badge variant="secondary">{c.pessoas} pessoas</Badge></DialogTitle>
          <DialogDescription>Cliente: {c.cliente_nome} · Operador: {c.operador_nome}</DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-5 gap-4">
          {/* Itens */}
          <div className="md:col-span-3 space-y-3">
            <div className="flex items-center justify-between"><Label>Itens da comanda</Label><Button size="sm" variant="outline" onClick={() => setAddOpen(!addOpen)}><Plus className="h-4 w-4 mr-1" />Adicionar item</Button></div>
            {addOpen && (
              <div className="space-y-2">
                <Input placeholder="Observacao (opcional) — ex: sem cebola" className="h-8 text-xs" value={obsPendente} onChange={(e) => setObsPendente(e.target.value)} />
                <div className="border rounded-lg divide-y max-h-40 overflow-auto ros-scroll">
                  {prods.filter((p) => p.disponivel !== false).map((p) => <button key={p.id} onClick={() => addItem(p)} className="w-full flex items-center justify-between p-2.5 hover:bg-accent text-left text-sm"><span>{p.nome}</span><span className="text-muted-foreground">{brl(p.preco)}</span></button>)}
                </div>
              </div>
            )}
            <div className="border rounded-lg divide-y">
              {(c.itens || []).length === 0 && <div className="p-4 text-sm text-muted-foreground text-center">Nenhum item lancado.</div>}
              {(c.itens || []).map((i) => (
                <div key={i.id} className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0"><div className="text-sm font-medium truncate">{i.nome}</div>{i.observacao && <div className="text-xs text-muted-foreground">{i.observacao}</div>}</div>
                  <div className="flex items-center gap-1.5"><Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setQty(i, i.quantidade - 1)}><Minus className="h-3 w-3" /></Button><span className="w-6 text-center text-sm">{i.quantidade}</span><Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setQty(i, i.quantidade + 1)}><Plus className="h-3 w-3" /></Button></div>
                  <div className="w-20 text-right text-sm font-medium">{brl(i.preco * i.quantidade)}</div>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setQty(i, 0)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
            {pix && (
              <Card><CardContent className="p-4 flex gap-4 items-center">
                {pix.qr_code_base64 ? <img alt="QR Pix" className="h-28 w-28 rounded-md bg-white p-1" src={`data:image/png;base64,${pix.qr_code_base64}`} /> : <div className="h-28 w-28 rounded-md bg-muted grid place-items-center"><QrCode className="h-8 w-8 text-muted-foreground" /></div>}
                <div className="flex-1 space-y-2">
                  <div className="text-sm font-medium">Pix · {brl(pix.valor)} · <span className="text-amber-500">{pix.status}</span></div>
                  {pix.qr_code && <div className="flex gap-2"><Input readOnly value={pix.qr_code} className="text-xs" /><Button size="icon" variant="outline" onClick={() => { navigator.clipboard.writeText(pix.qr_code); toast.success('Copiado') }}><Copy className="h-4 w-4" /></Button></div>}
                </div>
              </CardContent></Card>
            )}
          </div>
          {/* Resumo & acoes */}
          <div className="md:col-span-2 space-y-3">
            <Card><CardContent className="p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{brl(c.subtotal)}</span></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground flex items-center gap-1"><Percent className="h-3.5 w-3.5" />Desconto</span>
                <div className="flex items-center gap-1"><Input type="number" className="h-7 w-20 text-right" defaultValue={c.desconto} onBlur={(e) => updateComanda({ desconto: Number(e.target.value), desconto_tipo: c.desconto_tipo })} /><Select value={c.desconto_tipo} onValueChange={(v) => updateComanda({ desconto_tipo: v })}><SelectTrigger className="h-7 w-16"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="valor">R$</SelectItem><SelectItem value="percent">%</SelectItem></SelectContent></Select></div>
              </div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Taxa servico (%)</span><Input type="number" className="h-7 w-20 text-right" defaultValue={c.taxa_servico_percent} onBlur={(e) => updateComanda({ taxa_servico_percent: Number(e.target.value) })} /></div>
              <Separator />
              <div className="flex justify-between font-bold text-base"><span>Total</span><span>{brl(c.total)}</span></div>
              <div className="flex justify-between text-emerald-500"><span>Pago</span><span>{brl(c.pago)}</span></div>
              <div className="flex justify-between text-amber-500 font-medium"><span>Restante</span><span>{brl(c.restante)}</span></div>
              <div className="flex justify-between text-xs text-muted-foreground"><span className="flex items-center gap-1"><Split className="h-3 w-3" />Por pessoa ({c.pessoas})</span><span>{brl(porPessoa)}</span></div>
            </CardContent></Card>

            <Card><CardContent className="p-4 space-y-2">
              <Label className="text-xs">Registrar pagamento</Label>
              <div className="flex gap-2">
                <Select value={pay.metodo} onValueChange={(v) => setPay({ ...pay, metodo: v })}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dinheiro">Dinheiro</SelectItem><SelectItem value="pix">Pix</SelectItem><SelectItem value="cartao_debito">Debito</SelectItem><SelectItem value="cartao_credito">Credito</SelectItem></SelectContent></Select>
                <Input type="number" className="h-9" placeholder="Valor" value={pay.valor} onChange={(e) => setPay({ ...pay, valor: e.target.value })} />
                <Button className="h-9" onClick={addPay}>OK</Button>
              </div>
              <Button variant="outline" className="w-full h-9" onClick={() => setPay({ ...pay, valor: String(c.restante) })}>Preencher restante</Button>
              <Button variant="outline" className="w-full h-9" onClick={gerarPix}><QrCode className="h-4 w-4 mr-1" />Gerar Pix (Mercado Pago)</Button>
              {(c.pagamentos || []).length > 0 && <div className="space-y-1 pt-1">{c.pagamentos.map((p) => <div key={p.id} className="flex justify-between text-xs"><span className="text-muted-foreground capitalize">{p.metodo.replace('_', ' ')}</span><span className="text-emerald-500">{brl(p.valor)}</span></div>)}</div>}
            </CardContent></Card>

            {/* 3 botoes lado a lado (grid-cols-3) espremiam "Fechar conta" — o
                texto era cortado no limite direito do dialog mesmo em tela
                cheia, ja que a largura disponivel aqui e a coluna de resumo,
                nao o viewport. Acao primaria ganha linha propria, full-width. */}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => setTransferOpen(!transferOpen)}><ArrowRightLeft className="h-4 w-4 mr-1" />Transferir</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full"><Printer className="h-4 w-4 mr-1" />Imprimir</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => imprimirComanda(c, 'cozinha')}>Via cozinha</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => imprimirComanda(c, 'cliente')}>Via cliente (conta)</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Button className="w-full" onClick={fechar}><CheckCircle2 className="h-4 w-4 mr-1" />Fechar conta</Button>
            {transferOpen && (
              <div className="border rounded-lg p-2 max-h-32 overflow-auto ros-scroll">
                {mesasLivres.length === 0 && <div className="text-xs text-muted-foreground p-2">Nenhuma mesa livre.</div>}
                {mesasLivres.map((m) => <button key={m.id} onClick={() => transferir(m.id)} className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm">{m.nome}</button>)}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ ATENDIMENTO / DELIVERY ============================ */
const CONV_STATUS = {
  ABERTA: { label: 'Aberta', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/20', dot: 'bg-blue-500' },
  AGUARDANDO_EQUIPE: { label: 'Aguardando equipe', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/20', dot: 'bg-amber-500' },
  AGUARDANDO_CLIENTE: { label: 'Aguardando cliente', cls: 'bg-violet-500/15 text-violet-500 border-violet-500/20', dot: 'bg-violet-500' },
  RESOLVIDA: { label: 'Resolvida', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20', dot: 'bg-emerald-500' },
}
const PEDIDO_STEPS = [['novo', 'Recebido'], ['novo', 'Confirmado'], ['em_preparacao', 'Preparando'], ['pronto', 'Pronto'], ['saiu', 'Saiu p/ entrega'], ['entregue', 'Entregue']]
const STEP_ORDER = ['novo', 'em_preparacao', 'pronto', 'saiu', 'entregue']

function Atendimento() {
  const [convs, setConvs] = useState([])
  const [metrics, setMetrics] = useState(null)
  const [sel, setSel] = useState(null)
  const [ctx, setCtx] = useState(null)
  const [msgs, setMsgs] = useState([])
  const [texto, setTexto] = useState('')
  const [fStatus, setFStatus] = useState('todas')
  const [fPedido, setFPedido] = useState('todos')
  const [q, setQ] = useState('')
  const [novoPedido, setNovoPedido] = useState(false)
  const [sending, setSending] = useState(false)

  const loadList = useCallback(async () => {
    try {
      const qs = new URLSearchParams()
      if (fStatus !== 'todas') qs.set('status', fStatus)
      if (fPedido !== 'todos') qs.set('pedido_status', fPedido)
      if (q) qs.set('q', q)
      const [c, m] = await Promise.all([api(`/conversas?${qs}`), api('/conversas/metrics')])
      setConvs(c); setMetrics(m)
    } catch (e) {
      // Degrade de proposito: poll de 5s (linha abaixo), toast a cada falha
      // seria ruido continuo. console.error mantem a falha visivel no
      // devtools em vez de indistinguivel de "sem conversas".
      console.error('Falha ao atualizar lista de conversas:', e.message)
    }
  }, [fStatus, fPedido, q])
  const loadConversa = useCallback(async (id) => {
    try {
      const [detail, mm] = await Promise.all([api(`/conversas/${id}`), api(`/conversas/${id}/mensagens`)])
      setCtx(detail); setMsgs(mm)
      // Marcar como lida e best-effort: se falhar, so o contador de
      // nao-lidas fica desatualizado — nao afeta a conversa exibida.
      api(`/conversas/${id}/ler`, { method: 'POST' }).catch((e) => console.error('Falha ao marcar conversa como lida:', e.message))
    } catch (e) { toast.error(e.message) }
  }, [])
  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { const t = setInterval(() => { loadList(); if (sel) api(`/conversas/${sel}/mensagens`).then(setMsgs).catch((e) => console.error('Falha ao atualizar mensagens:', e.message)) }, 5000); return () => clearInterval(t) }, [loadList, sel])
  useEffect(() => { if (sel) loadConversa(sel) }, [sel, loadConversa])

  const enviar = async () => {
    if (!texto.trim() || !sel) return
    setSending(true)
    try { await api(`/conversas/${sel}/mensagens`, { method: 'POST', body: { texto } }); setTexto(''); loadConversa(sel); loadList() } catch (e) { toast.error(e.message) } finally { setSending(false) }
  }
  const setStatus = async (status) => { try { await api(`/conversas/${sel}`, { method: 'PUT', body: { status } }); loadConversa(sel); loadList() } catch (e) { toast.error(e.message) } }

  const cliente = ctx?.cliente
  const pedido = ctx?.pedido_ativo
  const stepIdx = pedido ? STEP_ORDER.indexOf(pedido.status_norm) : -1

  return (
    <div className="space-y-4 h-full flex flex-col">
      <PageHeader title="Central de Atendimento" description="Delivery via WhatsApp (Evolution API). Converse, acompanhe e crie pedidos sem sair da tela." />
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
          {[['Abertas', metrics.abertas], ['Não lidas', metrics.nao_lidas], ['Aguard. cliente', metrics.aguardando_cliente], ['Aguard. equipe', metrics.aguardando_equipe], ['Em andamento', metrics.pedidos_andamento], ['Prontos', metrics.pedidos_prontos], ['Em entrega', metrics.pedidos_entrega], ['Entregues hoje', metrics.pedidos_entregues_hoje]].map(([l, v]) => (
            <Card key={l}><CardContent className="p-3"><div className="text-xs text-muted-foreground truncate">{l}</div><div className="text-xl font-bold">{v}</div></CardContent></Card>
          ))}
        </div>
      )}
      <div className="grid lg:grid-cols-[320px_1fr_300px] gap-4 flex-1 min-h-0">
        {/* Col 1 - conversas */}
        <Card className="flex flex-col min-h-0">
          <div className="p-3 space-y-2 border-b">
            <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8 h-9" placeholder="Nome, telefone ou #pedido" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="flex gap-1 flex-wrap">
              {[['todas', 'Todas'], ['nao_lidas', 'Não lidas'], ['AGUARDANDO_EQUIPE', 'Equipe'], ['AGUARDANDO_CLIENTE', 'Cliente'], ['RESOLVIDA', 'Resolvidas']].map(([v, l]) => (
                <button key={v} onClick={() => setFStatus(v)} className={`text-xs px-2 py-1 rounded-md ${fStatus === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{l}</button>
              ))}
            </div>
            <Select value={fPedido} onValueChange={setFPedido}><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos os pedidos</SelectItem><SelectItem value="sem_pedido">Sem pedido</SelectItem><SelectItem value="novo">Pedido novo</SelectItem><SelectItem value="em_preparacao">Em preparação</SelectItem><SelectItem value="pronto">Pronto</SelectItem><SelectItem value="saiu">Saiu p/ entrega</SelectItem><SelectItem value="entregue">Entregue</SelectItem><SelectItem value="cancelado">Cancelado</SelectItem></SelectContent></Select>
          </div>
          <div className="flex-1 overflow-auto ros-scroll divide-y">
            {convs.map((c) => (
              <button key={c.id} onClick={() => setSel(c.id)} className={`w-full text-left p-3 hover:bg-accent ${sel === c.id ? 'bg-accent' : ''}`}>
                <div className="flex items-center gap-2">
                  <Avatar className="h-9 w-9"><AvatarFallback className="text-xs bg-primary/10 text-primary">{(c.contato_nome || '?').slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1"><span className="font-medium text-sm truncate">{c.contato_nome}</span><span className="text-[10px] text-muted-foreground shrink-0">{c.ultima_mensagem_em ? new Date(c.ultima_mensagem_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
                    <div className="flex items-center justify-between gap-1"><span className="text-xs text-muted-foreground truncate">{c.ultima_mensagem}</span>{c.nao_lidas > 0 && <span className="shrink-0 h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] grid place-items-center">{c.nao_lidas}</span>}</div>
                    <div className="flex items-center gap-1 mt-1"><span className={`h-1.5 w-1.5 rounded-full ${CONV_STATUS[c.status]?.dot}`} /><span className="text-[10px] text-muted-foreground">{CONV_STATUS[c.status]?.label}</span>{c.pedido && <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">#{c.pedido.numero}</Badge>}</div>
                  </div>
                </div>
              </button>
            ))}
            {convs.length === 0 && <Empty>Nenhuma conversa.</Empty>}
          </div>
        </Card>

        {/* Col 2 - chat */}
        <Card className="flex flex-col min-h-0">
          {!ctx ? <div className="flex-1 grid place-items-center text-muted-foreground text-sm"><div className="text-center"><MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />Selecione uma conversa</div></div> : (
            <>
              <div className="p-3 border-b flex items-center justify-between">
                <div className="flex items-center gap-2"><Avatar className="h-9 w-9"><AvatarFallback className="text-xs bg-primary/10 text-primary">{(ctx.conversa.contato_nome || '?').slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><div><div className="font-medium text-sm">{ctx.conversa.contato_nome}</div><div className="text-xs text-muted-foreground">{ctx.conversa.contato_numero}</div></div></div>
                <Select value={ctx.conversa.status} onValueChange={setStatus}><SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(CONV_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select>
              </div>
              <div className="flex-1 overflow-auto ros-scroll p-4 space-y-2 bg-muted/30">
                {msgs.map((m) => (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${m.from_me ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card border rounded-bl-sm'}`}>
                      {['image', 'audio', 'document'].includes(m.tipo) && <div className="text-xs opacity-70 mb-0.5">[{m.tipo}]</div>}
                      <div className="whitespace-pre-wrap break-words">{m.texto}</div>
                      <div className={`text-[10px] mt-0.5 ${m.from_me ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>{new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}{m.from_me && ` · ${m.status}`}</div>
                    </div>
                  </div>
                ))}
                {msgs.length === 0 && <Empty>Sem mensagens.</Empty>}
              </div>
              <div className="p-3 border-t flex gap-2">
                <Input placeholder="Digite uma mensagem…" value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && enviar()} />
                <Button onClick={enviar} disabled={sending}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enviar'}</Button>
              </div>
            </>
          )}
        </Card>

        {/* Col 3 - contexto */}
        <Card className="flex flex-col min-h-0 overflow-auto ros-scroll">
          {!ctx ? <div className="flex-1 grid place-items-center text-muted-foreground text-xs p-4 text-center">Contexto do cliente</div> : (
            <div className="p-4 space-y-4">
              <div><div className="text-xs text-muted-foreground">CLIENTE</div><div className="font-semibold">{cliente?.nome || ctx.conversa.contato_nome}</div><div className="text-sm text-muted-foreground">{ctx.conversa.contato_numero}</div></div>
              <Separator />
              <div>
                <div className="text-xs text-muted-foreground mb-2">PEDIDO ATUAL</div>
                {pedido ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between"><span className="font-semibold">#{pedido.numero}</span><Badge variant="outline" className={STATUS[pedido.status]?.cls || ''}>{STATUS[pedido.status]?.label || pedido.status}</Badge></div>
                    <div className="font-bold">{brl(pedido.total)}</div>
                    <div className="space-y-1">
                      {PEDIDO_STEPS.map(([sn, label], i) => {
                        const done = STEP_ORDER.indexOf(sn) < stepIdx || (STEP_ORDER.indexOf(sn) === stepIdx)
                        const current = STEP_ORDER.indexOf(sn) === stepIdx
                        return <div key={i} className="flex items-center gap-2 text-xs"><span className={`h-3 w-3 rounded-full grid place-items-center ${current ? 'bg-primary' : done ? 'bg-emerald-500' : 'bg-muted'}`}>{done && !current && <CheckCircle2 className="h-2.5 w-2.5 text-white" />}</span><span className={current ? 'font-medium' : 'text-muted-foreground'}>{label}</span></div>
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">{(pedido.itens || []).map((i) => `${i.quantidade}x ${i.nome}`).join(', ')}</div>
                  </div>
                ) : <div className="text-sm text-muted-foreground">Nenhum pedido ativo.</div>}
              </div>
              <Separator />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><div className="text-xs text-muted-foreground">Pedidos</div><div className="font-semibold">{ctx.historico?.total_pedidos || 0}</div></div>
                <div><div className="text-xs text-muted-foreground">Ticket</div><div className="font-semibold">{brl(ctx.historico?.ticket_medio || 0)}</div></div>
                <div><div className="text-xs text-muted-foreground">Último</div><div className="font-semibold text-xs">{ctx.historico?.ultimo_pedido ? new Date(ctx.historico.ultimo_pedido).toLocaleDateString('pt-BR') : '—'}</div></div>
              </div>
              {cliente?.endereco && <><Separator /><div><div className="text-xs text-muted-foreground">ENDEREÇO</div><div className="text-sm">{cliente.endereco}</div></div></>}
              <Separator />
              <Button className="w-full" onClick={() => setNovoPedido(true)}><Plus className="h-4 w-4 mr-1" />Novo pedido</Button>
            </div>
          )}
        </Card>
      </div>
      {novoPedido && <PedidoDialog clienteInicial={cliente?.id || ctx?.conversa?.cliente_id || null} onClose={() => setNovoPedido(false)} onSaved={() => { setNovoPedido(false); loadConversa(sel); loadList(); toast.success('Pedido criado') }} />}
    </div>
  )
}

/* ============================ SHELL ============================ */
const NAV = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard' },
  { key: 'pedidos', label: 'Pedidos', icon: ShoppingBag, perm: 'pedidos' },
  // `modulo` esconde o item quando a empresa nao tem o modulo contratado.
  // E cosmetico de proposito: o portao que vale e o 403 do servidor. Esconder
  // sem barrar no backend foi exatamente o bug que este campo veio consertar.
  { key: 'mesas', label: 'Mesas', icon: Armchair, perm: 'mesas', modulo: 'mesas' },
  { key: 'atendimento', label: 'Atendimento', icon: MessageSquare, perm: 'atendimento' },
  { key: 'cardapio', label: 'Cardápio', icon: UtensilsCrossed, perm: 'cardapio' },
  { key: 'clientes', label: 'Clientes', icon: Users, perm: 'clientes' },
  { key: 'financeiro', label: 'Financeiro', icon: Wallet, perm: 'financeiro' },
  { key: 'usuarios', label: 'Usuários', icon: UserCog, perm: 'usuarios' },
  { key: 'empresa', label: 'Empresa', icon: Building2, perm: 'empresa' },
  { key: 'integracoes', label: 'Integrações', icon: Plug, perm: 'integracoes' },
  { key: 'auditoria', label: 'Auditoria', icon: ScrollText, perm: 'auditoria' },
  { key: 'kds_concluir', label: 'Cozinha', icon: ChefHat, perm: 'pedidos' },
]

function App() {
  const [me, setMe] = useState(undefined) // undefined=loading, null=logged out
  const [view, setView] = useState('dashboard')
  const [mobileNav, setMobileNav] = useState(false)
  const { theme, setTheme } = useTheme()

  // TV do KDS: acesso por link tokenizado, sem login. Lido direto do
  // browser (nao via useSearchParams do Next) para nao exigir <Suspense>
  // do App Router; este componente ja e 'use client' e a leitura e so no
  // primeiro render.
  const kdsTvToken = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('kds_tv') : null
  const cardapioSlug = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cardapio') : null

  /**
   * `setTheme` do next-themes MUDA DE IDENTIDADE a cada troca de tema (ele
   * fecha sobre o tema atual para suportar atualizacao funcional). Antes,
   * `applyBranding` dependia dele e `loadMe` dependia de `applyBranding`, com
   * um `useEffect([loadMe])` chamando `loadMe(true)`. Resultado: trocar o tema
   * no botao recriava toda essa cadeia, o efeito disparava de novo, buscava
   * `/auth/me` e reaplicava `appearance.tema` da empresa por cima da escolha
   * do usuario — a tela voltava ao tema salvo depois de ~2s (o tempo da
   * requisicao). Guardar num ref quebra a cadeia: o tema da empresa e um
   * PADRAO INICIAL, nao algo a ser reimposto a cada recarga de dados.
   */
  const temaInicialAplicado = useRef(false)
  // `setTheme` acessado por ref para nao entrar em nenhuma lista de dependencias.
  const setThemeRef = useRef(setTheme)
  useEffect(() => { setThemeRef.current = setTheme }, [setTheme])

  const applyBranding = useCallback((empresa) => {
    const ap = empresa?.config?.appearance || {}
    const root = document.documentElement
    const hsl = ap.cor_principal ? hexToHsl(ap.cor_principal) : null
    if (hsl) { root.style.setProperty('--primary', hsl); root.style.setProperty('--ring', hsl); root.style.setProperty('--sidebar-primary', hsl); root.style.setProperty('--sidebar-ring', hsl) }
    // Sem `setTheme` aqui de proposito: manter esta funcao livre de qualquer
    // dependencia que mude junto com o tema.
  }, [])

  /** Aplica o tema padrao da empresa uma unica vez por sessao de app. */
  const aplicarTemaInicial = useCallback((empresa) => {
    if (temaInicialAplicado.current) return
    const tema = empresa?.config?.appearance?.tema
    if (tema) setThemeRef.current?.(tema)
    temaInicialAplicado.current = true
  }, [])

  const loadMe = useCallback(async () => {
    if (!getToken()) { setMe(null); return }
    try {
      const data = await api('/auth/me')
      setMe(data)
      applyBranding(data.empresa)
      aplicarTemaInicial(data.empresa)
    } catch {
      // Efeito visivel (kick pra tela de login), nao falha silenciosa — mas
      // trata qualquer erro (401 de token invalido OU 500/rede transitorio)
      // como "sessao invalida". Corrigir exige que api() carregue o status
      // HTTP no erro pra distinguir os casos; pertence a trilha C3 (Supabase
      // Auth + refresh de token), nao a este item. Ver PROFISSIONALIZACAO.md.
      localStorage.removeItem(TOKEN_KEY); setMe(null)
    }
  }, [applyBranding, aplicarTemaInicial])
  useEffect(() => { loadMe() }, [loadMe])

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY)
    setMe(null)
    setView('dashboard')
    // Libera para que o tema padrao da PROXIMA empresa a logar seja aplicado
    // (sem isso, quem entrasse depois herdaria o tema de quem saiu).
    temaInicialAplicado.current = false
  }

  if (kdsTvToken) return <KDSTv token={kdsTvToken} />
  if (cardapioSlug) return <CardapioPublico slug={cardapioSlug} />

  if (me === undefined) return <div className="min-h-screen grid place-items-center bg-background"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
  if (me === null) return <><AuthScreen onAuth={() => loadMe()} /><Toaster richColors position="top-right" /></>
  if (me.usuario?.papel === 'COZINHA') return <KDSView apiFetch={api} />

  const perms = me.permissions || []
  const has = (p) => perms.includes('*') || perms.includes(p)
  // Resolvido pelo servidor (/auth/me). Reinterpretar feature_flags aqui seria
  // uma segunda implementacao da regra de default, livre para divergir do
  // portao real. `?? {}` cobre token emitido antes deste campo existir —
  // modulo ausente conta como ligado, mesma direcao do backend.
  const modulos = me.modulos ?? {}
  const temMod = (m) => modulos[m] !== false
  const nav = NAV.filter((n) => has(n.perm) && (!n.modulo || temMod(n.modulo)))
  const initials = (me.usuario?.nome || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase()
  const brandName = me.empresa?.config?.appearance?.nome_exibido || me.empresa?.nome_comercial || me.empresa?.nome || 'Restaurant OS'
  const logo = me.empresa?.logo

  const Sidebar = ({ mobile }) => (
    <aside className={`${mobile ? 'flex' : 'hidden lg:flex'} w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar h-full`}>
      <div className="h-16 flex items-center gap-2 px-5 border-b border-sidebar-border font-semibold">
        {logo ? <img src={logo} alt="logo" className="h-8 w-8 rounded-lg object-cover" /> : <div className="h-8 w-8 rounded-lg bg-primary grid place-items-center text-primary-foreground"><ChefHat className="h-4.5 w-4.5" /></div>}
        <span className="truncate">{brandName}</span>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-auto ros-scroll">
        {nav.map((n) => {
          const active = view === n.key
          return (
            <button key={n.key} onClick={() => { setView(n.key); setMobileNav(false) }} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${active ? 'bg-sidebar-primary text-sidebar-primary-foreground font-medium' : 'text-sidebar-foreground hover:bg-sidebar-accent'}`}>
              <n.icon className="h-4 w-4" />{n.label}
            </button>
          )
        })}
      </nav>
      <div className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />{me.empresa?.nome}</div>
      </div>
    </aside>
  )

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      <Sidebar />
      {mobileNav && <div className="fixed inset-0 z-40 lg:hidden"><div className="absolute inset-0 bg-black/50" onClick={() => setMobileNav(false)} /><div className="absolute left-0 top-0 h-full"><Sidebar mobile /></div></div>}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 shrink-0 border-b flex items-center justify-between px-4 lg:px-6 gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)}><MenuIcon className="h-5 w-5" /></Button>
            <div>
              <div className="font-semibold capitalize">{NAV.find((n) => n.key === view)?.label}</div>
              <div className="text-xs text-muted-foreground">{me.empresa?.nome}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 pl-1 pr-2 h-9"><Avatar className="h-7 w-7"><AvatarFallback className="text-xs bg-primary text-primary-foreground">{initials}</AvatarFallback></Avatar><span className="hidden sm:block text-sm">{me.usuario?.nome}</span></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{me.usuario?.email}<div className="mt-1"><Badge variant="secondary">{me.roles?.[me.usuario?.papel]?.label || me.usuario?.papel}</Badge></div></div>
                <Separator className="my-1" />
                <DropdownMenuItem onClick={logout} className="text-destructive"><LogOut className="h-4 w-4 mr-2" />Sair</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto ros-scroll p-4 lg:p-6">
          {view === 'dashboard' && <Dashboard temMod={temMod} />}
          {view === 'pedidos' && <Pedidos me={me} />}
          {view === 'mesas' && <Mesas />}
          {view === 'atendimento' && <Atendimento />}
          {view === 'cardapio' && <Cardapio />}
          {view === 'clientes' && <Clientes />}
          {view === 'financeiro' && <Financeiro temMod={temMod} />}
          {view === 'usuarios' && <Usuarios roles={me.roles} />}
          {view === 'empresa' && <Empresa reload={loadMe} />}
          {view === 'integracoes' && <Integracoes />}
          {view === 'auditoria' && <Auditoria />}
          {view === 'kds_concluir' && <CozinhaPendentes apiFetch={api} />}
        </main>
      </div>
      <AlertaEstoqueGlobal ativo={temMod('estoque')} />
      <Toaster richColors position="top-right" />
    </div>
  )
}

export default App
