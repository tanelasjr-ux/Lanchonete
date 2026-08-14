# Cardápio Digital — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public, read-only digital menu accessible via link or QR code — no login required. Customers view products (photo, name, description, price) grouped by category. No cart, no ordering — customers still call the waiter to order (MVP scope, explicitly decided by the project owner).

**Architecture:** Follows the exact pattern already established by the KDS TV screen (`components/kds.jsx`, `KDSTv`): a public, unauthenticated view reached via a query parameter on the root route (`/?cardapio=<slug>`), read in `App()` via `window.location.search` (not `useSearchParams`, to avoid the App Router's `<Suspense>` requirement — see `app/page.js:2710-2714` comment), with an early return before the login gate. The backend exposes one new public GET route placed before the auth gate in `route.js`, mirroring where `/kds/pendentes` and `/kds/concluir` already live.

**Tech Stack:** No new tables, no new columns. Read-only projection over existing `empresas`, `produtos`, `categorias`. One new React component (`components/cardapio.jsx`), one new backend route, a QR/link generator in the existing Empresa settings screen (same tab pattern as `Cozinha (KDS)`).

**Spec supersedes:** none — new subsystem.

---

## Global Constraints

- **No authentication.** This is a deliberately public surface — same trust model as the KDS TV link (a bearer of the URL/QR sees the menu, nothing more).
- **Multi-tenant isolation via `empresa_id`.** The public route resolves `empresa_id` from the slug server-side; it is never accepted from the client body/query directly.
- **No cart, no order submission, no `POST`.** MVP scope decided explicitly with the project owner: visualization only. Any future "order from phone" flow is a separate, later spec — do not build toward it speculatively (YAGNI).
- **Only `ativo=true` empresas are servable.** A slug for a disabled/deleted tenant returns 404, not empresa data.
- **Only `ativo=true AND disponivel=true` products are shown**, and only `ativo=true` categories. Unavailable/inactive items are invisible in this view — never "shown but greyed", to keep the public payload minimal and avoid leaking discontinued items.
- **No secrets in the payload.** The public endpoint returns only display fields (see §3) — never `preco` history, `estoque_quantidade` raw counts, internal ids beyond what the UI needs to group/key React lists, or anything else from `empresas`/`produtos` not explicitly listed.

---

## 1. Backend: Public Route

### 1.1 Placement

Add to `app/api/[[...path]]/route.js`, in the same block as the existing KDS public routes (before line 711's `const session = await auth(request)` — the standard auth gate). Comment the same way the KDS block does, explaining why it's unauthenticated and placed early.

### 1.2 Route

```
GET /cardapio/:slug
```

Matched as `seg[0] === 'cardapio' && seg[1] && method === 'GET'` (same dynamic-segment style already used for `/usuarios/:id`, `/categorias/:id`, etc. — see `route.js:848` for the pattern).

### 1.3 Handler logic

```javascript
if (seg[0] === 'cardapio' && seg[1] && method === 'GET') {
  const empresa = await empresaRepo.findBySlug(seg[1])
  if (!empresa || !empresa.ativo) return err('Cardapio nao encontrado', 404)

  const [categorias, produtos] = await Promise.all([
    categoriaRepo.list(empresa.id),
    produtoRepo.list(empresa.id),
  ])

  const categoriasVisiveis = categorias
    .filter((c) => c.ativo)
    .sort((a, b) => a.ordem - b.ordem)
    .map((c) => ({ id: c.id, nome: c.nome }))

  const produtosVisiveis = produtos
    .filter((p) => p.ativo && p.disponivel)
    .map((p) => ({
      id: p.id,
      categoria_id: p.categoria_id,
      nome: p.nome,
      descricao: p.descricao,
      preco: p.preco,
      imagem: p.imagem,
    }))

  return json({
    empresa: {
      nome: empresa.nome_comercial || empresa.nome,
      logo: empresa.logo,
      cor_principal: empresa.config?.appearance?.cor_principal || null,
    },
    categorias: categoriasVisiveis,
    produtos: produtosVisiveis,
  })
}
```

**Why `empresaRepo.findBySlug` and not a new repository method:** the contract already exists (`ProdutoRepository`/`EmpresaRepository` interfaces, `packages/domain/src/index.ts:383`) and is implemented on both backends (used today during signup to dedupe slugs). No new repository code needed for this task.

**Why no pagination:** existing `/produtos` GET has no pagination either (`route.js:898`) — a restaurant's menu is bounded (tens to low hundreds of items), consistent with the rest of the app's approach.

**Why `categoriaRepo.list`/`produtoRepo.list` and filter in the Service, not a repository-level filtered query:** matches the existing convention throughout `route.js` — repositories return the tenant's full collection, filtering/shaping is Service-layer business logic (ADR-006, `docs/ARCHITECTURE.md`). Do not add a `listPublico()`-style method on the repository; that would put a display-shaping decision (which fields are public) into the persistence layer.

---

## 2. Frontend: Public View

### 2.1 Entry point (`app/page.js`)

Add alongside the existing `kdsTvToken` read (`app/page.js:2714`):

```javascript
const cardapioSlug = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cardapio') : null
```

And alongside the existing early return (`app/page.js:2769`):

```javascript
if (cardapioSlug) return <CardapioPublico slug={cardapioSlug} />
```

Placed in the same position relative to `kdsTvToken`'s check — both are unauthenticated, both must short-circuit before `me` (session) is evaluated.

### 2.2 New component: `components/cardapio.jsx`

Mirrors the structure of `components/kds.jsx` (own fetch, no dependency on the `api()` helper in `app/page.js` since there is no Bearer token to inject):

```javascript
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

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background border-b p-4 space-y-3">
        <div className="flex items-center gap-3">
          {dados.empresa.logo && <img src={dados.empresa.logo} alt="" className="h-10 w-10 rounded-full object-cover" />}
          <span className="font-bold text-lg">{dados.empresa.nome}</span>
        </div>
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
      </header>

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
    </div>
  )
}
```

**Why a plain `fetch`, not `api()`:** `api()` (defined in `app/page.js`) injects `Authorization: Bearer <token>` from `localStorage`. A public viewer has no token, and there's nothing to inject — same reasoning `KDSTv` already documents at the top of `components/kds.jsx`.

**Why no `estoque`/low-stock badge in this view:** out of scope per the approved design (Q&A: "Fotos dos produtos, Categorias/seções" only were selected; stock-status badge was offered and not chosen). Do not add it speculatively.

### 2.3 Import wiring

`app/page.js` imports `CardapioPublico` from `components/cardapio.jsx`, same import style as `import { KDSTv } from '@/components/kds'`.

---

## 3. Settings: Link + QR Generator

### 3.1 Location

Add a new tab **"Cardápio Digital"** to the Empresa settings screen, alongside the existing tabs (`Empresa`, `Aparência`, `Pagamentos`, `Módulos`, `Cozinha (KDS)`) — same tab-bar component, same visual pattern as the `Cozinha (KDS)` tab shown to the project owner.

### 3.2 Content

- **Public link**, computed client-side (no new backend call needed — the slug is already present on the loaded `empresa` object):
  ```javascript
  const linkCardapio = `${window.location.origin}/?cardapio=${empresa.slug}`
  ```
- **"Copiar link" button** — `navigator.clipboard.writeText(linkCardapio)`, same UX as the existing KDS link-copy buttons.
- **QR code**, rendered client-side. Add the `qrcode.react` package (new dependency — confirm with `yarn add qrcode.react` in the implementation plan) and render:
  ```jsx
  <QRCodeSVG value={linkCardapio} size={200} />
  ```
- **"Baixar QR" button** — serialize the rendered `<svg>` to a PNG via canvas (standard `qrcode.react` + canvas pattern) and trigger a download. If this proves nontrivial in the plan's spike, downloading the raw SVG is an acceptable fallback — note the decision in the plan rather than blocking on pixel-perfect PNG export.

### 3.3 No backend changes for this section

The slug already exists on every `empresa` row (`empresas.slug`, `packages/domain/src/index.ts:72`) and is already returned by the existing `GET /empresa` (or equivalent "load my company" call the settings screen already makes). Nothing new to persist — this is a pure display feature over existing data.

---

## 4. Error Handling

| Scenario | Behavior |
|---|---|
| Slug doesn't exist | `404` from backend → `CardapioPublico` shows "Cardapio nao encontrado" |
| Empresa exists but `ativo=false` | Same 404 path (owner deactivated the tenant — public menu must not leak) |
| Empresa has zero categorias | Grid still renders (no category filter bar), all products shown |
| Empresa has zero produtos disponíveis | "Nenhum produto encontrado" empty state |
| Network failure | Generic error message from the caught fetch rejection |
| Product has no `imagem` | "Sem foto" placeholder box, not a broken `<img>` |

---

## 5. Testing

- **Backend integration test** (new file or appended to an existing suite, decided in the plan): create an empresa + categoria + 2 produtos (one `disponivel=false`), hit `GET /cardapio/:slug` unauthenticated, assert: 200, correct `empresa.nome`, exactly 1 produto returned (the available one), category list correct.
- **404 case**: hit `GET /cardapio/does-not-exist`, assert 404.
- **Inactive tenant case**: create empresa with `ativo=false`, assert `GET /cardapio/:slug` returns 404 (not empresa data).
- **Multi-tenant isolation**: two empresas, each with their own produtos; assert empresa A's slug never returns empresa B's produtos.
- **Frontend**: manual verification via `run` skill / dev server — load `/?cardapio=<real-slug>`, confirm no login screen flashes, confirm category filter and search work, confirm mobile viewport (this is the primary use case — customer's phone).

No Playwright requirement beyond the manual pass above; this mirrors how KDS TV was validated (documented limitation of automating a truly public, tokenless screen is lower here since there's no `window.print()`-style blocking dialog involved).

---

## 6. Explicitly Out of Scope (MVP)

Recorded here so a future session doesn't "helpfully" build these without a fresh design pass:

- Cart / add-to-order from the digital menu.
- Per-table QR (this MVP is empresa-wide, not table-scoped — explicitly decided in Q&A).
- Stock/"indisponível" badges tied to `estoque_quantidade` (offered, not selected).
- Menu personalization per QR source (e.g., different menu for delivery vs. dine-in).
- Analytics on menu views/scans.
