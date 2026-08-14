# Cardápio Digital Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a public, unauthenticated digital menu accessible via link (`/?cardapio=<slug>`) or QR code. Customers view products grouped by category, with search. No login, no cart, no ordering — visualization only.

**Architecture:** Follows the established KDS TV pattern: a query parameter (`?cardapio=<slug>`) read client-side in `App()` triggers an early return to a public component before login. One new backend route (`GET /cardapio/:slug`) placed before the auth gate returns empresa/categoria/produto data. New React component (`CardapioPublico`) renders the menu with category filtering and search. Settings gain a "Cardápio Digital" tab with link/QR generator.

**Tech Stack:** React (`CardapioPublico` component), `qrcode.react` npm package (new dependency), existing backend repos (no new schema/tables), existing Next.js App Router pattern.

**Spec:** `docs/superpowers/specs/2026-08-14-cardapio-digital-design.md`

## Global Constraints

- **No authentication required.** Public surface — URL/QR bearer can access only display fields (`nome`, `preco`, `imagem`, `descricao`).
- **Multi-tenant isolation via `empresa_id` resolved server-side from slug.** Never accept `empresa_id` from the request body/query.
- **Only `ativo=true` empresas and `ativo=true AND disponivel=true` productos are servable.** Inactive/unavailable items are invisible, not greyed.
- **No cart, no order submission.** MVP scope explicitly decided. Read-only visualization.
- **Repository contracts must not change.** Use existing `empresaRepo.findBySlug()`, `categoriaRepo.list()`, `produtoRepo.list()` — no new filtered variants.
- **Follow KDS TV pattern for public routes.** Placement: before the auth gate in `route.js`. Client-side: query param read via `window.location.search`, early return in `App()`.
- **No speculative features.** Out of scope per spec §6: cart, per-table QR, stock badges, menu personalization, analytics.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/api/[[...path]]/route.js` | Add `GET /cardapio/:slug` handler (public, before auth gate) |
| `app/page.js` | Read `?cardapio` query param, early return to `<CardapioPublico />` |
| `components/cardapio.jsx` | **New.** `CardapioPublico` component — fetch menu, filter by category/search, render grid |
| `package.json` | Add `qrcode.react` dependency |
| `tests/backend_test_cardapio.py` | **New.** Backend integration tests (empresa/categoria/produto isolation, 404 cases) |

---

## Task 1: Add Dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `qrcode.react` package available in `node_modules`

- [ ] **Step 1: Add qrcode.react to package.json**

Open `package.json`, find the `"dependencies"` section, and add:
```json
"qrcode.react": "^1.0.1"
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
yarn install
```

Expected: `qrcode.react` installed successfully, `yarn.lock` updated.

- [ ] **Step 3: Verify import works**

```bash
node -e "require('qrcode.react')" && echo "OK"
```

Expected: `OK` (no error).

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore: add qrcode.react dependency for cardapio digital"
```

---

## Task 2: Backend Route (GET /cardapio/:slug)

**Files:**
- Modify: `app/api/[[...path]]/route.js` (lines ~635–640, the KDS section)

**Interfaces:**
- Consumes: `empresaRepo.findBySlug(slug)`, `categoriaRepo.list(empresa_id)`, `produtoRepo.list(empresa_id)`, existing `Empresa`/`Categoria`/`Produto` types
- Produces: HTTP 200 with `{ empresa: { nome, logo, cor_principal }, categorias: [ { id, nome } ], produtos: [ { id, categoria_id, nome, descricao, preco, imagem } ] }`

- [ ] **Step 1: Locate the KDS section**

Open `app/api/[[...path]]/route.js`, find the comment at line ~635: `/* ==================== KDS (leitura/acao publica via token OU JWT) ====================`. This is where public unauthenticated routes live, before the main auth gate (line ~711).

- [ ] **Step 2: Write the handler code**

After the KDS block (after the `/kds/concluir` handler, before the `const session = await auth(request)` line), insert:

```javascript
/* ==================== CARDAPIO DIGITAL (visualizacao publica, sem login) ==================== */

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

- [ ] **Step 3: Verify syntax**

```bash
node -c app/api/[[...path]]/route.js
```

Expected: No output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: add GET /cardapio/:slug endpoint (public, unauthenticated)"
```

---

## Task 3: Frontend Component (CardapioPublico)

**Files:**
- Create: `components/cardapio.jsx`

**Interfaces:**
- Consumes: `/?cardapio=<slug>` query parameter (read by `App()` before passing `slug` prop), `GET /cardapio/:slug` endpoint (from Task 2)
- Produces: React component `<CardapioPublico slug={string} />` that renders the full menu UI

- [ ] **Step 1: Create the component file**

Create `components/cardapio.jsx`:

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

- [ ] **Step 2: Verify no syntax errors**

```bash
node -e "require('./components/cardapio.jsx')" && echo "Component loads"
```

(This will fail because JSX is not directly executable in Node — that's OK. The real test is in Task 4 when the app runs.)

- [ ] **Step 3: Commit**

```bash
git add components/cardapio.jsx
git commit -m "feat: add CardapioPublico component (public menu display)"
```

---

## Task 4: Wire Query Parameter in App()

**Files:**
- Modify: `app/page.js` (lines ~2714 and ~2769)

**Interfaces:**
- Consumes: `CardapioPublico` component (from Task 3), existing `App()` structure
- Produces: `?cardapio=<slug>` query param triggers early return to CardapioPublico

- [ ] **Step 1: Locate the kdsTvToken read**

Open `app/page.js`, find line ~2714 (search for `const kdsTvToken = typeof window`).

- [ ] **Step 2: Add cardapioSlug read**

After the `kdsTvToken` line, add:

```javascript
const cardapioSlug = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cardapio') : null
```

- [ ] **Step 3: Locate the kdsTvToken early return**

Find line ~2769 (search for `if (kdsTvToken) return <KDSTv`).

- [ ] **Step 4: Add cardapioSlug early return**

After the `kdsTvToken` return, add:

```javascript
if (cardapioSlug) return <CardapioPublico slug={cardapioSlug} />
```

- [ ] **Step 5: Add import at the top**

Find the imports section (around line 1–20, where `import { KDSTv } from '@/components/kds'` already exists). Add:

```javascript
import { CardapioPublico } from '@/components/cardapio'
```

- [ ] **Step 6: Verify syntax**

```bash
node -c app/page.js
```

Expected: No output (syntax OK).

- [ ] **Step 7: Commit**

```bash
git add app/page.js
git commit -m "feat: wire ?cardapio query param to CardapioPublico early return"
```

---

## Task 5: Settings Tab (Link + QR Generator)

**Files:**
- Modify: `app/page.js` (lines ~1994 and ~2133, the Empresa settings tab section)

**Interfaces:**
- Consumes: existing `empresa` object (already loaded in settings), `qrcode.react` npm package (from Task 1)
- Produces: "Cardápio Digital" tab with link display, copy button, QR code, download button

- [ ] **Step 1: Add qrcode.react import**

At the top of `app/page.js`, find the lucide-react imports (around line 10–20). Add `QRCodeSVG` to the imports from `qrcode.react`:

```javascript
import QRCodeSVG from 'qrcode.react'
```

- [ ] **Step 2: Add TabsTrigger for "Cardápio Digital"**

Find line ~1994 (the TabsList with "Empresa", "Aparencia", etc.). Add a new trigger:

```jsx
<TabsTrigger value="cardapio">Cardápio Digital</TabsTrigger>
```

Insert it **after** the `Cozinha (KDS)` trigger, so the order is: `dados`, `aparencia`, `pagamentos`, `modulos`, `kds`, `cardapio`.

- [ ] **Step 3: Add TabsContent for "Cardápio Digital"**

Find line ~2133 (after the closing tag of the KDS tab, which is `</TabsContent>`). Add:

```jsx
<TabsContent value="cardapio" className="mt-4">
  <div className="space-y-4">
    <div>
      <h3 className="font-semibold mb-2">Link Público</h3>
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?cardapio=${empresa.slug}`}
          className="flex-1 border rounded px-3 py-2 text-sm bg-muted"
        />
        <button
          onClick={() => {
            const link = `${window.location.origin}/?cardapio=${empresa.slug}`
            navigator.clipboard.writeText(link)
            alert('Link copiado!')
          }}
          className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded"
        >
          Copiar
        </button>
      </div>
    </div>
    <div>
      <h3 className="font-semibold mb-2">Código QR</h3>
      <div className="flex flex-col items-center gap-3">
        <QRCodeSVG
          value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?cardapio=${empresa.slug}`}
          size={200}
          level="H"
          includeMargin={true}
        />
        <button
          onClick={async () => {
            const canvas = document.querySelector('canvas')
            if (!canvas) return
            const link = document.createElement('a')
            link.href = canvas.toDataURL('image/png')
            link.download = `cardapio-${empresa.slug}.png`
            link.click()
          }}
          className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded"
        >
          Baixar QR
        </button>
      </div>
    </div>
  </div>
</TabsContent>
```

**Note:** The QR code is rendered by `<QRCodeSVG>` as an SVG. The "Download QR" button tries to find a rendered canvas element (which `qrcode.react` may generate if configured to do so). If this doesn't work in your environment, an acceptable fallback is to remove the download button or download the SVG directly via an `<a href={qrSvgRef}>`; the spec allows this flexibility per §3.2.

- [ ] **Step 4: Verify syntax**

```bash
node -c app/page.js
```

Expected: No output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat: add Cardápio Digital tab with link/QR generator"
```

---

## Task 6: Backend Tests (Integration)

**Files:**
- Create: `tests/backend_test_cardapio.py`

**Interfaces:**
- Consumes: `GET /cardapio/:slug` endpoint (from Task 2)
- Produces: Passing test suite confirming backend behavior (isolation, 404 cases, filtering)

- [ ] **Step 1: Create test file**

Create `tests/backend_test_cardapio.py`:

```python
import os
import pytest
import requests
from urllib.parse import quote

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

def test_cardapio_empresa_valida():
    """Cardápio de empresa válida retorna produtos e categorias."""
    # Pré-setup: criar empresa + categoria + produtos
    signup = requests.post(f"{BASE_URL}/signup", json={"nome": "Test Cardapio", "email": f"test-cardapio-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa_id = signup["empresa_id"]
    token = signup["token"]
    headers = {"Authorization": f"Bearer {token}"}
    
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    empresa_slug = empresa["slug"]
    
    # Criar categoria
    cat = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas", "ordem": 1}, headers=headers).json()
    cat_id = cat["id"]
    
    # Criar produtos: 1 disponível, 1 não
    p1 = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Café", "descricao": "Quente", "preco": 5.0, "disponivel": True},
        headers=headers
    ).json()
    p2 = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Chá Gelado", "descricao": "Frio", "preco": 8.0, "disponivel": False},
        headers=headers
    ).json()
    
    # Chamar cardápio sem autenticação
    res = requests.get(f"{BASE_URL}/cardapio/{quote(empresa_slug)}")
    assert res.status_code == 200
    
    data = res.json()
    assert data["empresa"]["nome"] == empresa["nome_comercial"] or empresa["nome"]
    assert len(data["categorias"]) == 1
    assert data["categorias"][0]["nome"] == "Bebidas"
    
    # Apenas 1 produto (o disponível)
    assert len(data["produtos"]) == 1
    assert data["produtos"][0]["nome"] == "Café"
    assert data["produtos"][0]["preco"] == 5.0

def test_cardapio_empresa_nao_existe():
    """Slug inválido retorna 404."""
    res = requests.get(f"{BASE_URL}/cardapio/empresa-fantasma-{os.urandom(4).hex()}")
    assert res.status_code == 404

def test_cardapio_multitenant():
    """Duas empresas não veem as categorias/produtos uma da outra."""
    # Empresa 1
    signup1 = requests.post(f"{BASE_URL}/signup", json={"nome": "Empresa A", "email": f"empA-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa1_id = signup1["empresa_id"]
    token1 = signup1["token"]
    headers1 = {"Authorization": f"Bearer {token1}"}
    
    empresa1 = requests.get(f"{BASE_URL}/empresa", headers=headers1).json()
    slug1 = empresa1["slug"]
    
    cat1 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas A", "ordem": 1}, headers=headers1).json()
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat1["id"], "nome": "Produto A", "preco": 10.0, "disponivel": True},
        headers=headers1
    )
    
    # Empresa 2
    signup2 = requests.post(f"{BASE_URL}/signup", json={"nome": "Empresa B", "email": f"empB-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa2_id = signup2["empresa_id"]
    token2 = signup2["token"]
    headers2 = {"Authorization": f"Bearer {token2}"}
    
    empresa2 = requests.get(f"{BASE_URL}/empresa", headers=headers2).json()
    slug2 = empresa2["slug"]
    
    cat2 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas B", "ordem": 1}, headers=headers2).json()
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat2["id"], "nome": "Produto B", "preco": 20.0, "disponivel": True},
        headers=headers2
    )
    
    # Verificar isolamento
    res1 = requests.get(f"{BASE_URL}/cardapio/{quote(slug1)}")
    res2 = requests.get(f"{BASE_URL}/cardapio/{quote(slug2)}")
    
    assert res1.status_code == 200
    assert res2.status_code == 200
    
    data1 = res1.json()
    data2 = res2.json()
    
    # Empresa 1 vê apenas seus dados
    assert data1["categorias"][0]["nome"] == "Bebidas A"
    assert data1["produtos"][0]["nome"] == "Produto A"
    
    # Empresa 2 vê apenas seus dados
    assert data2["categorias"][0]["nome"] == "Bebidas B"
    assert data2["produtos"][0]["nome"] == "Produto B"

def test_cardapio_sem_categoria():
    """Empresa com categorias mas zero produtos retorna array vazio."""
    signup = requests.post(f"{BASE_URL}/signup", json={"nome": "Test Empty", "email": f"empty-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    token = signup["token"]
    headers = {"Authorization": f"Bearer {token}"}
    
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]
    
    requests.post(f"{BASE_URL}/categorias", json={"nome": "Vazia", "ordem": 1}, headers=headers)
    
    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}")
    assert res.status_code == 200
    
    data = res.json()
    assert len(data["categorias"]) == 1
    assert len(data["produtos"]) == 0

if __name__ == '__main__':
    pytest.main([__file__, '-v'])
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
BASE_URL=http://localhost:3000/api python3 -m pytest tests/backend_test_cardapio.py -v
```

Expected: 4 tests passing.

- [ ] **Step 3: Commit**

```bash
git add tests/backend_test_cardapio.py
git commit -m "test: add cardapio backend integration tests (isolation, 404, filtering)"
```

---

## Task 7: Final Verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: All tasks 1–6
- Produces: Passing build, passing tests, clean git status

- [ ] **Step 1: Run full build**

```bash
npm run build
```

Expected: Build completes without errors.

- [ ] **Step 2: Verify no syntax errors in key files**

```bash
node -c app/api/[[...path]]/route.js
node -c app/page.js
```

Expected: No output (all OK).

- [ ] **Step 3: Run backend tests**

```bash
BASE_URL=http://localhost:3000/api python3 -m pytest tests/backend_test_cardapio.py -v
```

Expected: 4/4 passing.

- [ ] **Step 4: Check git status**

```bash
git status
```

Expected: Clean (no uncommitted changes in code files).

- [ ] **Step 5: Manual test (run dev server)**

```bash
yarn dev
```

Then in browser:
- `http://localhost:3000/?cardapio=<your-test-empresa-slug>` → Should load the menu with no login screen
- Search bar should filter products by name
- Category tabs should filter by category
- Copy link button should work
- QR code should be visible

- [ ] **Step 6: Commit (verification complete)**

```bash
git add -A
git commit -m "docs: cardapio digital implementation complete (7/7 tasks)"
```

---

## Spec Coverage Check

| Section | Task | Status |
|---|---|---|
| §1 Backend route | Task 2 | ✅ GET /cardapio/:slug, empresa/categoria/produto data |
| §2 Frontend view | Task 3 | ✅ CardapioPublico component, category filter, search |
| §3 Settings tab | Task 5 | ✅ Link copy, QR generator |
| §4 Error handling | Task 6 | ✅ Tests cover 404, isolation, filtering |
| §5 Testing | Task 6 | ✅ Backend integration tests |
| §6 Out of scope | — | ✅ Spec explicitly marks these out of scope; no tasks build toward them |

All requirements covered. No gaps.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-14-cardapio-digital-implementation.md`. 

## Execution Options

**Two approaches available:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Ideal for parallel work and rigorous review gates.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster for small specs, good for tight feedback loops.

**Which approach would you prefer?**

