'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTheme } from 'next-themes'
import {
  LayoutDashboard, UtensilsCrossed, Users, ShoppingBag, Wallet, Building2,
  UserCog, ScrollText, Plug, Sun, Moon, LogOut, Plus, Search, Trash2, Pencil,
  ChefHat, TrendingUp, TrendingDown, DollarSign, Package, ArrowUpRight,
  CheckCircle2, Clock, ChefHat as Chef, MoreVertical, X, Loader2, ShieldCheck,
  MessageSquare, Workflow, Menu as MenuIcon,
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

const STATUS = {
  recebido: { label: 'Recebido', cls: 'bg-blue-500/15 text-blue-500 border-blue-500/20' },
  em_preparo: { label: 'Em Preparo', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/20' },
  pronto: { label: 'Pronto', cls: 'bg-violet-500/15 text-violet-500 border-violet-500/20' },
  concluido: { label: 'Concluído', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20' },
  cancelado: { label: 'Cancelado', cls: 'bg-red-500/15 text-red-500 border-red-500/20' },
}
const FLOW = ['recebido', 'em_preparo', 'pronto', 'concluido']

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

/* ============================ DASHBOARD ============================ */
function Dashboard() {
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
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([api('/categorias'), api('/produtos')])
    setCats(c); setProds(p)
  }, [])
  useEffect(() => { load().catch((e) => toast.error(e.message)) }, [load])

  const saveProd = async (data) => {
    try {
      if (data.id) await api(`/produtos/${data.id}`, { method: 'PUT', body: data })
      else await api('/produtos', { method: 'POST', body: data })
      toast.success('Produto salvo'); setDlg(null); load()
    } catch (e) { toast.error(e.message) }
  }
  const delProd = async (id) => { try { await api(`/produtos/${id}`, { method: 'DELETE' }); toast.success('Produto removido'); load() } catch (e) { toast.error(e.message) } }
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
                    <DropdownMenuItem className="text-destructive" onClick={() => delProd(p.id)}><Trash2 className="h-4 w-4 mr-2" />Remover</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {p.descricao && <p className="text-sm text-muted-foreground line-clamp-2">{p.descricao}</p>}
              <div className="flex items-center justify-between pt-1">
                <span className="font-bold text-lg">{brl(p.preco)}</span>
                <Badge variant="outline" className={p.disponivel ? 'text-emerald-500 border-emerald-500/20 bg-emerald-500/10' : 'text-muted-foreground'}>{p.disponivel ? 'Disponível' : 'Indisponível'}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
        {filtered.length === 0 && <div className="col-span-full"><Empty>Nenhum produto nesta categoria.</Empty></div>}
      </div>

      {dlg && <ProdutoDialog data={dlg} cats={cats} onClose={() => setDlg(null)} onSave={saveProd} />}
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Preço (R$)</Label><Input type="number" step="0.01" value={f.preco} onChange={(e) => set('preco', e.target.value)} /></div>
            <div className="space-y-2"><Label>Categoria</Label>
              <Select value={f.categoria_id || ''} onValueChange={(v) => set('categoria_id', v)}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2"><Label>Descrição</Label><Textarea value={f.descricao || ''} onChange={(e) => set('descricao', e.target.value)} rows={2} /></div>
          <div className="flex items-center justify-between rounded-lg border p-3"><Label>Disponível</Label><Switch checked={f.disponivel !== false} onCheckedChange={(v) => set('disponivel', v)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={() => onSave(f)}>Salvar</Button></DialogFooter>
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
function Pedidos() {
  const [pedidos, setPedidos] = useState([])
  const [dlg, setDlg] = useState(false)
  const load = useCallback(() => api('/pedidos').then(setPedidos).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const move = async (p, status) => { try { await api(`/pedidos/${p.id}`, { method: 'PUT', body: { status } }); load() } catch (e) { toast.error(e.message) } }
  const cols = [...FLOW]
  return (
    <div className="space-y-6">
      <PageHeader title="Pedidos" description="Acompanhe e movimente os pedidos pelo fluxo de produção." action={<Button onClick={() => setDlg(true)}><Plus className="h-4 w-4 mr-1" />Novo pedido</Button>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cols.map((col) => {
          const items = pedidos.filter((p) => p.status === col)
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
                        <div className="flex items-center justify-between pt-1"><span className="font-bold">{brl(p.total)}</span><span className="text-xs text-muted-foreground">{fmtDate(p.created_at)}</span></div>
                        <div className="flex gap-2 pt-1">
                          {next && <Button size="sm" className="flex-1 h-8" onClick={() => move(p, next)}>{STATUS[next].label} <ArrowUpRight className="h-3.5 w-3.5 ml-1" /></Button>}
                          {p.status !== 'cancelado' && p.status !== 'concluido' && <Button size="sm" variant="outline" className="h-8 text-destructive" onClick={() => move(p, 'cancelado')}><X className="h-3.5 w-3.5" /></Button>}
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
    </div>
  )
}
function PedidoDialog({ onClose, onSaved }) {
  const [prods, setProds] = useState([])
  const [clientes, setClientes] = useState([])
  const [itens, setItens] = useState([])
  const [cliente_id, setCliente] = useState('')
  const [tipo, setTipo] = useState('balcao')
  const [pagamento, setPag] = useState('pix')
  useEffect(() => { api('/produtos').then(setProds); api('/clientes').then(setClientes) }, [])
  const add = (p) => setItens((s) => { const ex = s.find((i) => i.produto_id === p.id); if (ex) return s.map((i) => i.produto_id === p.id ? { ...i, quantidade: i.quantidade + 1 } : i); return [...s, { produto_id: p.id, nome: p.nome, preco: p.preco, quantidade: 1 }] })
  const dec = (id) => setItens((s) => s.map((i) => i.produto_id === id ? { ...i, quantidade: Math.max(0, i.quantidade - 1) } : i).filter((i) => i.quantidade > 0))
  const total = itens.reduce((s, i) => s + i.preco * i.quantidade, 0)
  const save = async () => { if (!itens.length) return toast.error('Adicione ao menos 1 item'); try { await api('/pedidos', { method: 'POST', body: { itens, cliente_id: cliente_id || null, tipo, pagamento } }); toast.success('Pedido criado'); onSaved() } catch (e) { toast.error(e.message) } }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Novo pedido</DialogTitle><DialogDescription>Selecione os itens e finalize o pedido.</DialogDescription></DialogHeader>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Produtos</Label>
            <div className="border rounded-lg divide-y max-h-72 overflow-auto ros-scroll">
              {prods.map((p) => (
                <button key={p.id} onClick={() => add(p)} className="w-full flex items-center justify-between p-3 hover:bg-accent text-left text-sm">
                  <span>{p.nome}</span><span className="text-muted-foreground">{brl(p.preco)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label className="text-xs">Cliente</Label>
                <Select value={cliente_id} onValueChange={setCliente}><SelectTrigger><SelectValue placeholder="Consumidor" /></SelectTrigger><SelectContent>{clientes.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}</SelectContent></Select>
              </div>
              <div className="space-y-1"><Label className="text-xs">Tipo</Label>
                <Select value={tipo} onValueChange={setTipo}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="balcao">Balcão</SelectItem><SelectItem value="delivery">Delivery</SelectItem><SelectItem value="retirada">Retirada</SelectItem></SelectContent></Select>
              </div>
            </div>
            <div className="space-y-1"><Label className="text-xs">Pagamento</Label>
              <Select value={pagamento} onValueChange={setPag}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pix">Pix</SelectItem><SelectItem value="cartao">Cartão</SelectItem><SelectItem value="dinheiro">Dinheiro</SelectItem></SelectContent></Select>
            </div>
            <Separator />
            <div className="space-y-2 max-h-40 overflow-auto ros-scroll">
              {itens.length === 0 && <p className="text-sm text-muted-foreground">Nenhum item adicionado.</p>}
              {itens.map((i) => (
                <div key={i.produto_id} className="flex items-center justify-between text-sm">
                  <span className="flex-1">{i.nome}</span>
                  <div className="flex items-center gap-2"><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => dec(i.produto_id)}>-</Button><span className="w-5 text-center">{i.quantidade}</span><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => add({ id: i.produto_id, nome: i.nome, preco: i.preco })}>+</Button></div>
                  <span className="w-20 text-right font-medium">{brl(i.preco * i.quantidade)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between font-bold text-lg pt-2 border-t"><span>Total</span><span>{brl(total)}</span></div>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button><Button onClick={save}>Criar pedido</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ============================ FINANCEIRO ============================ */
function Financeiro() {
  const [resumo, setResumo] = useState(null)
  const [tx, setTx] = useState([])
  const [dlg, setDlg] = useState(false)
  const load = useCallback(async () => { const [r, t] = await Promise.all([api('/financeiro/resumo'), api('/financeiro/transacoes')]); setResumo(r); setTx(t) }, [])
  useEffect(() => { load().catch((e) => toast.error(e.message)) }, [load])
  const save = async (d) => { try { await api('/financeiro/transacoes', { method: 'POST', body: d }); toast.success('Lançamento adicionado'); setDlg(false); load() } catch (e) { toast.error(e.message) } }
  if (!resumo) return <Empty>Carregando…</Empty>
  return (
    <div className="space-y-6">
      <PageHeader title="Financeiro" description="Fluxo de caixa, receitas e despesas do restaurante." action={<Button onClick={() => setDlg(true)}><Plus className="h-4 w-4 mr-1" />Lançamento</Button>} />
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
      {dlg && <TxDialog onClose={() => setDlg(false)} onSave={save} />}
    </div>
  )
}
function TxDialog({ onClose, onSave }) {
  const [f, setF] = useState({ tipo: 'despesa', categoria: '', descricao: '', valor: '' })
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }))
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo lançamento</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Tipo</Label><Select value={f.tipo} onValueChange={(v) => set('tipo', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="receita">Receita</SelectItem><SelectItem value="despesa">Despesa</SelectItem></SelectContent></Select></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Categoria</Label><Input value={f.categoria} onChange={(e) => set('categoria', e.target.value)} placeholder="Ex: Insumos" /></div>
            <div className="space-y-2"><Label>Valor (R$)</Label><Input type="number" step="0.01" value={f.valor} onChange={(e) => set('valor', e.target.value)} /></div>
          </div>
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
function Empresa({ reload }) {
  const [f, setF] = useState(null)
  useEffect(() => { api('/empresa').then(setF).catch((e) => toast.error(e.message)) }, [])
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const save = async () => { try { await api('/empresa', { method: 'PUT', body: { nome: f.nome, telefone: f.telefone, endereco: f.endereco, moeda: f.moeda } }); toast.success('Dados atualizados'); reload?.() } catch (e) { toast.error(e.message) } }
  if (!f) return <Empty>Carregando…</Empty>
  const flags = f.config?.feature_flags || {}
  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Empresa" description="Dados cadastrais e módulos da plataforma." />
      <Card>
        <CardHeader><CardTitle className="text-base">Dados da empresa</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label>Nome</Label><Input value={f.nome} onChange={set('nome')} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Telefone</Label><Input value={f.telefone || ''} onChange={set('telefone')} /></div>
            <div className="space-y-2"><Label>Moeda</Label><Input value={f.moeda || 'BRL'} onChange={set('moeda')} /></div>
          </div>
          <div className="space-y-2"><Label>Endereço</Label><Input value={f.endereco || ''} onChange={set('endereco')} /></div>
          <div className="text-xs text-muted-foreground">Slug: <code className="bg-muted px-1.5 py-0.5 rounded">{f.slug}</code> · Plano: <Badge variant="secondary">{f.plano}</Badge></div>
          <Button onClick={save}>Salvar alterações</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Módulos futuros (Feature Flags)</CardTitle><CardDescription>Arquitetura já preparada para ativação sem refatoração.</CardDescription></CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          {['Controle de Mesas', 'Estoque', 'CRM', 'Campanhas', 'Fidelidade', 'Billing SaaS'].map((n, i) => {
            const key = ['mesas', 'estoque', 'crm', 'campanhas', 'fidelidade', 'billing'][i]
            return (
              <div key={n} className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-sm">{n}</span>
                <Badge variant="outline" className="text-muted-foreground">{flags[key] ? 'Ativo' : 'Em breve'}</Badge>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

/* ============================ INTEGRAÇÕES ============================ */
function Integracoes() {
  const [data, setData] = useState(null)
  const [testing, setTesting] = useState('')
  const load = useCallback(() => api('/integracoes').then(setData).catch((e) => toast.error(e.message)), [])
  useEffect(() => { load() }, [load])
  const [ev, setEv] = useState({ serverUrl: '', apiKey: '', instance: 'restaurant-os' })
  const [n8, setN8] = useState({ webhookUrl: '', apiKey: '' })
  useEffect(() => { if (data) { setEv({ ...ev, ...(data.evolution?.config || {}) }); setN8({ ...n8, ...(data.n8n?.config || {}) }) } }, [data])
  const saveEv = async () => { try { await api('/integracoes/evolution', { method: 'PUT', body: ev }); toast.success('Evolution API salva'); load() } catch (e) { toast.error(e.message) } }
  const saveN8 = async () => { try { await api('/integracoes/n8n', { method: 'PUT', body: n8 }); toast.success('n8n salvo'); load() } catch (e) { toast.error(e.message) } }
  const testEv = async () => { setTesting('ev'); try { const r = await api('/integracoes/evolution/testar', { method: 'POST' }); r.connected ? toast.success('WhatsApp conectado!') : toast.warning(r.message || `Estado: ${r.state}`) } catch (e) { toast.error(e.message) } finally { setTesting('') } }
  const testN8 = async () => { setTesting('n8'); try { const r = await api('/integracoes/n8n/testar', { method: 'POST' }); r.connected ? toast.success('Webhook n8n respondeu!') : toast.warning(r.message || 'Sem resposta') } catch (e) { toast.error(e.message) } finally { setTesting('') } }
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
            <div className="space-y-2"><Label>API Key</Label><Input value={ev.apiKey} onChange={(e) => setEv({ ...ev, apiKey: e.target.value })} placeholder="••••••••" /></div>
            <div className="space-y-2"><Label>Instância</Label><Input value={ev.instance} onChange={(e) => setEv({ ...ev, instance: e.target.value })} /></div>
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

/* ============================ SHELL ============================ */
const NAV = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: 'dashboard' },
  { key: 'pedidos', label: 'Pedidos', icon: ShoppingBag, perm: 'pedidos' },
  { key: 'cardapio', label: 'Cardápio', icon: UtensilsCrossed, perm: 'cardapio' },
  { key: 'clientes', label: 'Clientes', icon: Users, perm: 'clientes' },
  { key: 'financeiro', label: 'Financeiro', icon: Wallet, perm: 'financeiro' },
  { key: 'usuarios', label: 'Usuários', icon: UserCog, perm: 'usuarios' },
  { key: 'empresa', label: 'Empresa', icon: Building2, perm: 'empresa' },
  { key: 'integracoes', label: 'Integrações', icon: Plug, perm: 'integracoes' },
  { key: 'auditoria', label: 'Auditoria', icon: ScrollText, perm: 'auditoria' },
]

function App() {
  const [me, setMe] = useState(undefined) // undefined=loading, null=logged out
  const [view, setView] = useState('dashboard')
  const [mobileNav, setMobileNav] = useState(false)
  const { theme, setTheme } = useTheme()

  const loadMe = useCallback(async () => {
    if (!getToken()) { setMe(null); return }
    try { setMe(await api('/auth/me')) } catch { localStorage.removeItem(TOKEN_KEY); setMe(null) }
  }, [])
  useEffect(() => { loadMe() }, [loadMe])

  const logout = () => { localStorage.removeItem(TOKEN_KEY); setMe(null); setView('dashboard') }

  if (me === undefined) return <div className="min-h-screen grid place-items-center bg-background"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
  if (me === null) return <><AuthScreen onAuth={loadMe} /><Toaster richColors position="top-right" /></>

  const perms = me.permissions || []
  const has = (p) => perms.includes('*') || perms.includes(p)
  const nav = NAV.filter((n) => has(n.perm))
  const initials = (me.usuario?.nome || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase()

  const Sidebar = ({ mobile }) => (
    <aside className={`${mobile ? 'flex' : 'hidden lg:flex'} w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar h-full`}>
      <div className="h-16 flex items-center gap-2 px-5 border-b border-sidebar-border font-semibold">
        <div className="h-8 w-8 rounded-lg bg-primary grid place-items-center text-primary-foreground"><ChefHat className="h-4.5 w-4.5" /></div>
        <span>Restaurant OS</span>
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
          {view === 'dashboard' && <Dashboard />}
          {view === 'pedidos' && <Pedidos />}
          {view === 'cardapio' && <Cardapio />}
          {view === 'clientes' && <Clientes />}
          {view === 'financeiro' && <Financeiro />}
          {view === 'usuarios' && <Usuarios roles={me.roles} />}
          {view === 'empresa' && <Empresa reload={loadMe} />}
          {view === 'integracoes' && <Integracoes />}
          {view === 'auditoria' && <Auditoria />}
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  )
}

export default App
