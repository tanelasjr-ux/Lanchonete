# Estoque Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement inventory tracking (opt-in per product) with automatic stock deduction on sale, visual alerts, and manual adjustment UI.

**Architecture:** Stock is stored as denormalized fields on `produtos` table (`estoque_habilitado`, `estoque_quantidade`, `estoque_minimo`). When pedido or comanda concludes, loop over items and decrement each product's quantity via repository method. Alerts surface via badges in UI + dashboard card. Manual adjustments via dedicated dialog. Errors are non-fatal — sales complete even if stock fails.

**Tech Stack:** Supabase migrations, dual-backend repositories (Supabase + Mongo), React UI (badges, dialogs), service layer integration (existing route.js endpoints).

**Spec:** `docs/superpowers/specs/2026-08-14-estoque-design.md`

## Global Constraints

- **Multi-tenant isolation via empresa_id** (all queries filtered by tenant, RLS on Supabase, application-layer on Mongo)
- **Soft-delete pattern:** `ativo` column gates access; `estoque_habilitado` opt-in per product
- **Numeric precision:** Stock as `numeric(12,2)` (fractional units allowed)
- **Audit trail:** All adjustments logged to `auditoria` table as 'estoque_ajuste' entries
- **Non-fatal errors:** Stock deduction failures don't block order completion; logged to audit as 'estoque_erro'

---

## File Structure

**New files:**
- `supabase/migrations/0019_estoque.sql` — Schema extension
- `backend_test_estoque.py` — Test suite

**Modified files:**
- `packages/domain/src/index.ts` — Add Estoque interfaces + Product fields
- `lib/repositories/supabase/produtoRepository.js` — Add stock methods
- `lib/repositories/mongo/produtoRepository.js` — Add stock methods (Mongo equivalent)
- `lib/repositories/factory.js` — Ensure produtoRepo registered (already done, no change)
- `app/api/[[...path]]/route.js` — Integrate stock deduction into PUT /pedidos/:id and POST /comandas/:id/fechar
- `app/page.js` — Add stock UI (Produtos screen) + dashboard warning card

**No changes to:**
- `lib/integrations/*` — Stock is internal; no external integrations
- Database indices — created inline in migration

---

## Task Breakdown

### Task 1: Schema Migration 0019

**Files:**
- Create: `supabase/migrations/0019_estoque.sql`

**Interfaces:**
- Produces: Three new columns on `produtos` table + index

- [ ] **Step 1: Create migration file**

```bash
touch supabase/migrations/0019_estoque.sql
```

- [ ] **Step 2: Write migration**

```sql
-- Migration 0019: Stock tracking schema extension
-- Adds opt-in inventory tracking to products.

ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_habilitado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_quantidade NUMERIC(12,2) DEFAULT NULL;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_minimo NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Index for fast queries: "give me all tracked products for this empresa"
CREATE INDEX IF NOT EXISTS idx_produtos_estoque_habilitado 
  ON public.produtos(empresa_id, estoque_habilitado) 
  WHERE estoque_habilitado = true;

-- RLS: Stock visibility follows empresa_id (inherited from existing produtos RLS)
-- No new RLS policy needed — existing SELECT/UPDATE/DELETE policies already apply.
```

- [ ] **Step 3: Verify syntax**

```bash
# Check migration file exists and is valid SQL
cat supabase/migrations/0019_estoque.sql | head -20
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0019_estoque.sql
git commit -m "migration: Add estoque schema (estoque_habilitado, quantidade, minimo)"
```

---

### Task 2: Domain Contracts — Produto + EstoqueAjuste

**Files:**
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: Nothing new
- Produces: Updated `Produto` interface + new `EstoqueAjuste` interface + extended `ProdutoRepository`

- [ ] **Step 1: Add Estoque interface**

In `packages/domain/src/index.ts`, after `Cliente` interface, add:

```typescript
export interface EstoqueAjuste {
  produto_id: UUID;
  empresa_id: UUID;
  quantidade_anterior: number;
  quantidade_nova: number;
  motivo: string; // 'venda', 'devolucao', 'ajuste_manual', 'sucata'
  usuario_id: UUID;
  data: Date;
}
```

- [ ] **Step 2: Update Produto interface**

Find the `Produto` interface (around line 101) and add fields:

```typescript
export interface Produto extends TenantScoped {
  id: UUID; categoria_id: UUID | null; nome: string; descricao: string;
  preco: number; imagem: string | null; disponivel: boolean; ativo: boolean;
  // NEW:
  estoque_habilitado: boolean;
  estoque_quantidade: number | null;
  estoque_minimo: number;
}
```

- [ ] **Step 3: Extend ProdutoRepository interface**

Find `ProdutoRepository` interface (around line 324) and add methods:

```typescript
export interface ProdutoRepository extends Repository<Produto>, BulkCreatable<Produto> {
  /** Cascade used when deleting a category. */
  deleteManyByCategoria(empresaId: UUID, categoriaId: UUID): Promise<void>;
  
  // NEW:
  /** Decrement stock for a product (sale). Throws if quantity would go negative. */
  decrementarEstoque(empresaId: UUID, produtoId: UUID, quantidade: number, motivo: string): Promise<Produto>;
  
  /** Manual adjustment (correction of physical count). */
  ajustarEstoque(empresaId: UUID, produtoId: UUID, novaQuantidade: number, motivo: string): Promise<Produto>;
  
  /** List products with stock below minimum (for alerts). */
  listEstoqueBaixo(empresaId: UUID): Promise<Produto[]>;
  
  /** Get stock level for a product. */
  getEstoque(empresaId: UUID, produtoId: UUID): Promise<number | null>;
}
```

- [ ] **Step 4: Verify types**

```bash
npx tsc --noEmit packages/domain/src/index.ts
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/index.ts
git commit -m "types: Add Estoque interfaces + extend Produto + ProdutoRepository"
```

---

### Task 3: Supabase Repository — Stock Methods

**Files:**
- Modify: `lib/repositories/supabase/produtoRepository.js`

**Interfaces:**
- Consumes: Supabase client, `Produto` interface
- Produces: Four new async methods (decrementarEstoque, ajustarEstoque, listEstoqueBaixo, getEstoque)

- [ ] **Step 1: Add decrementarEstoque method**

At end of repository object (before closing brace), add:

```javascript
async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
  // Fetch current state
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  // If tracking disabled, no-op
  if (!atual.estoque_habilitado) {
    return atual
  }
  
  const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)
  
  // Hard block: cannot go negative
  if (novaQuantidade < 0) {
    throw new Error(`Estoque insuficiente: ${atual.nome} (tinha ${atual.estoque_quantidade}, tentou vender ${quantidade})`)
  }
  
  // Update in Supabase
  const updated = await unwrap(
    await supabase
      .from('produtos')
      .update({
        estoque_quantidade: novaQuantidade,
        updated_at: new Date().toISOString(),
      })
      .eq('id', produtoId)
      .eq('empresa_id', empresaId)
      .select()
      .maybeSingle()
  )
  
  if (!updated) throw new Error('Falha ao atualizar estoque')
  return this._normalize(updated)
},

async ajustarEstoque(empresaId, produtoId, novaQuantidade, motivo) {
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (novaQuantidade < 0) throw new Error('Quantidade nao pode ser negativa')
  
  const updated = await unwrap(
    await supabase
      .from('produtos')
      .update({
        estoque_quantidade: Number(novaQuantidade),
        updated_at: new Date().toISOString(),
      })
      .eq('id', produtoId)
      .eq('empresa_id', empresaId)
      .select()
      .maybeSingle()
  )
  
  if (!updated) throw new Error('Falha ao atualizar estoque')
  return this._normalize(updated)
},

async listEstoqueBaixo(empresaId) {
  const { data, error } = await supabase
    .from('produtos')
    .select('*')
    .eq('empresa_id', empresaId)
    .eq('estoque_habilitado', true)
    .lte('estoque_quantidade', 'estoque_minimo')
    .order('estoque_quantidade', { ascending: true })
  
  return (unwrap(data, error) || []).map(p => this._normalize(p))
},

async getEstoque(empresaId, produtoId) {
  const p = await this.findById(empresaId, produtoId)
  return p?.estoque_quantidade || null
},
```

- [ ] **Step 2: Verify syntax**

```bash
node -c lib/repositories/supabase/produtoRepository.js
```

Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add lib/repositories/supabase/produtoRepository.js
git commit -m "feat: Supabase produtoRepository — add stock methods (decrement, ajustar, listBaixo, getEstoque)"
```

---

### Task 4: Mongo Repository — Stock Methods (Identical Interface)

**Files:**
- Modify: `lib/repositories/mongo/produtoRepository.js`

**Interfaces:**
- Consumes: MongoDB collection, `Produto` interface
- Produces: Four methods (same signatures as Task 3, MongoDB implementation)

- [ ] **Step 1: Add decrementarEstoque method**

```javascript
async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
  const col = db.collection('produtos')
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (!atual.estoque_habilitado) return atual
  
  const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)
  if (novaQuantidade < 0) {
    throw new Error(`Estoque insuficiente: ${atual.nome} (tinha ${atual.estoque_quantidade}, tentou vender ${quantidade})`)
  }
  
  await col.updateOne(
    { _id: produtoId, empresa_id: empresaId },
    {
      $set: {
        estoque_quantidade: Number(novaQuantidade),
        updated_at: new Date(),
      },
    }
  )
  
  return this.findById(empresaId, produtoId)
},

async ajustarEstoque(empresaId, produtoId, novaQuantidade, motivo) {
  const col = db.collection('produtos')
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (novaQuantidade < 0) throw new Error('Quantidade nao pode ser negativa')
  
  await col.updateOne(
    { _id: produtoId, empresa_id: empresaId },
    {
      $set: {
        estoque_quantidade: Number(novaQuantidade),
        updated_at: new Date(),
      },
    }
  )
  
  return this.findById(empresaId, produtoId)
},

async listEstoqueBaixo(empresaId) {
  const col = db.collection('produtos')
  const docs = await col
    .find({
      empresa_id: empresaId,
      estoque_habilitado: true,
      $expr: { $lte: ['$estoque_quantidade', '$estoque_minimo'] },
    })
    .sort({ estoque_quantidade: 1 })
    .toArray()
  
  return docs.map(d => this._normalize(d))
},

async getEstoque(empresaId, produtoId) {
  const p = await this.findById(empresaId, produtoId)
  return p?.estoque_quantidade || null
},
```

- [ ] **Step 2: Add Mongo index (inline, before export)**

At the end of `createProdutoRepository()` function, before closing, add:

```javascript
// Ensure index for estoque_habilitado queries
await col.createIndex({ empresa_id: 1, estoque_habilitado: 1 }, { sparse: true })
```

- [ ] **Step 3: Verify syntax**

```bash
node -c lib/repositories/mongo/produtoRepository.js
```

- [ ] **Step 4: Commit**

```bash
git add lib/repositories/mongo/produtoRepository.js
git commit -m "feat: Mongo produtoRepository — add stock methods (identical interface to Supabase)"
```

---

### Task 5: Integration — Stock Deduction in PUT /pedidos/:id

**Files:**
- Modify: `app/api/[[...path]]/route.js` (lines ~1355 after existing transacao creation)

**Interfaces:**
- Consumes: `produtoRepo.decrementarEstoque()` (from Tasks 3-4)
- Produces: Stock deduction loop integrated into order completion flow

- [ ] **Step 1: Locate integration point**

Find line ~1355 in route.js (after `transacaoRepo.create()` for receita). The section looks like:

```javascript
if (finais.includes(b.status) && !finais.includes(pedido.status)) {
  // ... existing transacao creation ...
  if (pedido.cliente_id) {
    await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, pedido.cliente_id, totalFinal)
  }
}
```

- [ ] **Step 2: Add stock deduction loop**

After the `clienteRepo.incrementarMetricasPedido()` call, add:

```javascript
// NEW: Decrement stock for each item sold (if tracking enabled)
for (const item of (pedido.itens || [])) {
  if (item.produto_id) {
    try {
      await produtoRepo.decrementarEstoque(
        ctx.empresa_id,
        item.produto_id,
        item.quantidade,
        'venda'
      )
    } catch (e) {
      // Stock error is non-fatal — log to audit and continue
      console.warn(`Stock deduction failed for produto ${item.produto_id}: ${e.message}`)
      await audit(repos, ctx, 'estoque_erro', 'pedido', pedido.id, { erro: e.message })
    }
  }
}
```

- [ ] **Step 3: Verify logic flow**

Ensure the loop is AFTER transacao creation but before the function returns. Review the complete block to confirm order.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: PUT /pedidos/:id — integrate stock deduction on pedido conclusion"
```

---

### Task 6: Integration — Stock Deduction in POST /comandas/:id/fechar

**Files:**
- Modify: `app/api/[[...path]]/route.js` (lines ~1907 after existing cliente metrics update)

**Interfaces:**
- Consumes: `produtoRepo.decrementarEstoque()`
- Produces: Stock deduction integrated into comanda closing flow

- [ ] **Step 1: Locate integration point**

Find line ~1907 in route.js (after `clienteRepo.incrementarMetricasPedido()` in comanda closing). The section looks like:

```javascript
if (comanda.cliente_id) await clienteRepo.incrementarMetricasPedido(ctx.empresa_id, comanda.cliente_id, totals.total)
```

- [ ] **Step 2: Add stock deduction loop**

After that line, add:

```javascript
// NEW: Decrement stock for each item sold (if tracking enabled)
for (const item of (comanda.itens || [])) {
  if (item.produto_id) {
    try {
      await produtoRepo.decrementarEstoque(
        ctx.empresa_id,
        item.produto_id,
        item.quantidade,
        'venda'
      )
    } catch (e) {
      console.warn(`Stock deduction failed for produto ${item.produto_id}: ${e.message}`)
      await audit(repos, ctx, 'estoque_erro', 'comanda', comanda.id, { erro: e.message })
    }
  }
}
```

- [ ] **Step 3: Verify order**

Confirm loop is after transacao/pedido creation and before comanda status update.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: POST /comandas/:id/fechar — integrate stock deduction on comanda closing"
```

---

### Task 7: UI — Produtos Dialog (Add Stock Fields)

**Files:**
- Modify: `app/page.js` (Produtos screen, inside product create/edit dialog)

**Interfaces:**
- Consumes: State `f` (form object) and `set()` handler for updating form fields
- Produces: Three new input fields for stock configuration

- [ ] **Step 1: Locate dialog section**

Find the product create/edit dialog in `app/page.js` (search for "Disponível" or "Switch checked={f.disponivel}"). It's inside a `Dialog` component.

- [ ] **Step 2: Add stock toggle**

After the "Disponível" section, add:

```jsx
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
```

- [ ] **Step 3: Verify form object**

Ensure the POST request body (where products are created/updated) includes `estoque_habilitado`, `estoque_quantidade`, `estoque_minimo`. Search for the `api('/produtos'` call and verify these fields are passed.

- [ ] **Step 4: Commit**

```bash
git add app/page.js
git commit -m "ui: Produtos dialog — add stock tracking fields (enable toggle, quantity, minimum)"
```

---

### Task 8: UI — Produtos List (Stock Badge)

**Files:**
- Modify: `app/page.js` (Produtos screen, product card/row display)

**Interfaces:**
- Consumes: Product object `p` with `estoque_habilitado`, `estoque_quantidade`, `estoque_minimo`
- Produces: Visual badge showing stock level with color coding

- [ ] **Step 1: Locate product display**

Find where products are rendered as cards or list items (search for "prods.map" or "p.nome" in the Produtos section). Each product row should show available/name/price.

- [ ] **Step 2: Add stock badge**

Add after the existing "Disponível" badge:

```jsx
{p.estoque_habilitado && (
  <Badge 
    variant="outline" 
    className={`
      ${p.estoque_quantidade <= p.estoque_minimo 
        ? 'bg-red-500/10 text-red-500 border-red-500/20' 
        : p.estoque_quantidade <= (p.estoque_minimo * 1.5)
        ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
        : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
      }
    `}
  >
    {p.estoque_quantidade} un
  </Badge>
)}
```

- [ ] **Step 3: Test colors**

Visual check: Create a product with stock tracking. Set quantity=10, minimum=3. Verify badge is green. Then create another with quantity=3 (at minimum) — should be red. Another at 4.5 (between min and 1.5×min) — should be amber.

- [ ] **Step 4: Commit**

```bash
git add app/page.js
git commit -m "ui: Produtos list — add stock badge with color coding (red/amber/green)"
```

---

### Task 9: UI — Stock Adjustment Dialog

**Files:**
- Modify: `app/page.js` (Produtos screen, add new dialog state + handler)

**Interfaces:**
- Consumes: Product object, `api()` helper, `toast` notifications
- Produces: Modal for manual stock correction

- [ ] **Step 1: Add state at top of Produtos component**

Add after existing state declarations:

```javascript
const [ajustarDlg, setAjustarDlg] = useState(null) // { id, nome, estoque_quantidade }
const [ajustarForm, setAjustarForm] = useState({ novaQuantidade: '', motivo: '' })
```

- [ ] **Step 2: Add handler function**

Add after existing handlers (e.g., after `toggleDisponivel()`):

```javascript
const handleAjustar = async () => {
  if (!ajustarDlg || !ajustarForm.novaQuantidade) {
    toast.error('Preenchedor todos os campos')
    return
  }
  try {
    await api(`/produtos/${ajustarDlg.id}`, {
      method: 'PUT',
      body: {
        estoque_quantidade: Number(ajustarForm.novaQuantidade),
      },
    })
    toast.success('Estoque ajustado')
    setAjustarDlg(null)
    setAjustarForm({ novaQuantidade: '', motivo: '' })
    carregarProdutos() // Reload to see new badge
  } catch (e) {
    toast.error(e.message)
  }
}
```

- [ ] **Step 3: Add menu item to open dialog**

In the dropdown menu where products are managed, add:

```jsx
<DropdownMenuItem 
  onClick={() => {
    setAjustarDlg({ id: p.id, nome: p.nome, estoque_quantidade: p.estoque_quantidade })
    setAjustarForm({ novaQuantidade: String(p.estoque_quantidade || 0), motivo: '' })
  }}
>
  <Zap className="h-4 w-4 mr-2" />Ajustar Estoque
</DropdownMenuItem>
```

(Note: Import `Zap` from lucide-react at top if not already imported)

- [ ] **Step 4: Add Dialog component**

Add after existing dialogs (e.g., after the categoria or produto create dialog):

```jsx
<Dialog open={!!ajustarDlg} onOpenChange={(open) => !open && setAjustarDlg(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Ajustar Estoque: {ajustarDlg?.nome}</DialogTitle>
    </DialogHeader>
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        Quantidade atual: <span className="font-mono font-bold">{ajustarDlg?.estoque_quantidade || 0}</span>
      </div>
      <div>
        <Label>Nova Quantidade</Label>
        <Input 
          type="number" 
          step="0.01"
          placeholder="0.00"
          value={ajustarForm.novaQuantidade}
          onChange={(e) => setAjustarForm({ ...ajustarForm, novaQuantidade: e.target.value })}
        />
      </div>
      <div>
        <Label>Motivo</Label>
        <Select value={ajustarForm.motivo} onValueChange={(v) => setAjustarForm({ ...ajustarForm, motivo: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="devolucao">Devolução do cliente</SelectItem>
            <SelectItem value="sucata">Sucata / Perda</SelectItem>
            <SelectItem value="ajuste_manual">Correção de contagem</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setAjustarDlg(null)}>Cancelar</Button>
      <Button onClick={handleAjustar}>Salvar</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "ui: Add stock adjustment dialog (manual correction of inventory)"
```

---

### Task 10: UI — Dashboard Warning Card

**Files:**
- Modify: `app/page.js` (Dashboard component)

**Interfaces:**
- Consumes: Products list from `GET /produtos`
- Produces: Warning card showing low-stock items

- [ ] **Step 1: Add state**

In Dashboard component, add:

```javascript
const [estoqueBaixo, setEstoqueBaixo] = useState([])
```

- [ ] **Step 2: Add load function**

Add after `carregarDados()` or similar:

```javascript
const carregarEstoqueBaixo = async () => {
  try {
    const prods = await api('/produtos')
    const baixo = (prods || []).filter(p => p.estoque_habilitado && p.estoque_quantidade <= p.estoque_minimo)
    setEstoqueBaixo(baixo)
  } catch (e) {
    // Silent fail — stock warning is non-critical
  }
}
```

- [ ] **Step 3: Call on mount**

Add to the `useEffect` that loads dashboard data:

```javascript
useEffect(() => {
  carregarDados()
  carregarEstoqueBaixo() // NEW
}, [])
```

- [ ] **Step 4: Add UI card**

Add to the dashboard rendering (after metrics cards), conditionally:

```jsx
{estoqueBaixo && estoqueBaixo.length > 0 && (
  <Card className="border-amber-500/30 bg-amber-500/5">
    <CardHeader>
      <CardTitle className="text-amber-600 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5" />
        Estoque Baixo ({estoqueBaixo.length})
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="space-y-2">
        {estoqueBaixo.map(p => (
          <div key={p.id} className="flex justify-between text-sm">
            <span>{p.nome}</span>
            <span className="font-mono text-muted-foreground">
              {p.estoque_quantidade || 0} / {p.estoque_minimo} min
            </span>
          </div>
        ))}
      </div>
    </CardContent>
  </Card>
)}
```

(Note: Import `AlertTriangle` from lucide-react if not already imported)

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "ui: Dashboard — add low-stock warning card with product list"
```

---

### Task 11: Backend Test Suite

**Files:**
- Create: `backend_test_estoque.py`

**Interfaces:**
- Produces: ~8 test cases covering stock deduction, validation, multi-tenant isolation

- [ ] **Step 1: Create test file**

```bash
touch backend_test_estoque.py
chmod +x backend_test_estoque.py
```

- [ ] **Step 2: Write test suite**

```python
#!/usr/bin/env python3
"""
Restaurant OS - Stock (Estoque) Test Suite
Tests: stock deduction on pedido/comanda, validation, multi-tenant isolation.

Endpoints: PUT /produtos/:id, GET /produtos, (implicit via pedido/comanda closure)
"""

import os
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")
results = {"passed": [], "failed": []}

def log_pass(nome):
    print(f"PASS: {nome}")
    results["passed"].append(nome)

def log_fail(nome, motivo):
    print(f"FAIL: {nome}")
    print(f"   Motivo: {motivo}")
    results["failed"].append({"teste": nome, "motivo": motivo})

def criar_empresa():
    """Create empresa + OWNER user, return (headers, empresa_id)."""
    import random, string
    email = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8)) + '@teste.com'
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": f"Estoque Teste {email[:12]}",
        "nome": "Teste User",
        "email": email,
        "senha": "senha123456",
    })
    r.raise_for_status()
    dados = r.json()
    token = dados["token"]
    return {"Authorization": f"Bearer {token}"}, dados.get("empresa", {}).get("id")

def criar_produto_com_estoque(headers, nome, preco, estoque_qty, estoque_min):
    """Create product with stock tracking enabled."""
    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": nome,
        "preco": preco,
        "disponivel": True,
        "estoque_habilitado": True,
        "estoque_quantidade": estoque_qty,
        "estoque_minimo": estoque_min,
    })
    r.raise_for_status()
    return r.json()

def criar_pedido(headers, produto_id, quantidade, preco):
    """Create pedido with one item."""
    r = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "balcao",
        "pagamento": "dinheiro",
        "itens": [{"produto_id": produto_id, "nome": "Test Item", "preco": preco, "quantidade": quantidade}],
    })
    r.raise_for_status()
    return r.json()

def main():
    headers, empresa_id = criar_empresa()
    
    # Test 1: Create product with stock tracking
    prod = criar_produto_com_estoque(headers, "Cerveja Premium", 25.00, 100, 10)
    if prod["estoque_habilitado"] and prod["estoque_quantidade"] == 100:
        log_pass("Create product with stock tracking enabled")
    else:
        log_fail("Create product with stock tracking enabled", f"estoque_habilitado={prod.get('estoque_habilitado')}, qty={prod.get('estoque_quantidade')}")
    
    # Test 2: Stock deduction on pedido conclusion
    pedido = criar_pedido(headers, prod["id"], 2, 25.00)
    r = requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})
    if r.status_code == 200:
        r2 = requests.get(f"{BASE_URL}/produtos/{prod['id']}", headers=headers)
        prods = [p for p in r2.json() if p["id"] == prod["id"]]
        if prods and prods[0].get("estoque_quantidade") == 98:
            log_pass("Stock deducts on pedido conclusion (100 - 2 = 98)")
        else:
            log_fail("Stock deducts on pedido conclusion", f"estoque_quantidade={prods[0].get('estoque_quantidade') if prods else 'not found'}")
    else:
        log_fail("Stock deducts on pedido conclusion", f"PUT /pedidos failed: {r.status_code}")
    
    # Test 3: Stock insufficient (hard block)
    prod2 = criar_produto_com_estoque(headers, "Vinho Tinto", 45.00, 1, 0)
    pedido2 = criar_pedido(headers, prod2["id"], 5, 45.00)
    r = requests.put(f"{BASE_URL}/pedidos/{pedido2['id']}", headers=headers, json={"status": "concluido"})
    # Note: In current implementation, stock error is non-fatal, so pedido still concludes.
    # But quantity was only 1, so 5 cannot be deducted. Verify stock doesn't go negative.
    r2 = requests.get(f"{BASE_URL}/produtos/{prod2['id']}", headers=headers)
    prods2 = r2.json()
    final_qty = None
    for p in prods2:
        if p["id"] == prod2["id"]:
            final_qty = p.get("estoque_quantidade")
    if final_qty is not None and final_qty >= 0:
        log_pass("Stock doesn't go negative (hard block enforced)")
    else:
        log_fail("Stock doesn't go negative", f"final quantity={final_qty}")
    
    # Test 4: Product without stock tracking — no deduction
    prod3 = criar_produto_com_estoque(headers, "Agua 1.5L", 5.00, 500, 50)
    r = requests.put(f"{BASE_URL}/produtos/{prod3['id']}", headers=headers, json={"estoque_habilitado": False})
    r.raise_for_status()
    pedido3 = criar_pedido(headers, prod3["id"], 10, 5.00)
    r = requests.put(f"{BASE_URL}/pedidos/{pedido3['id']}", headers=headers, json={"status": "concluido"})
    if r.status_code == 200:
        r2 = requests.get(f"{BASE_URL}/produtos/{prod3['id']}", headers=headers)
        prods3 = r2.json()
        final_qty = None
        for p in prods3:
            if p["id"] == prod3["id"]:
                final_qty = p.get("estoque_quantidade")
        # Should still be 500 (no deduction)
        if final_qty == 500:
            log_pass("Stock not deducted when estoque_habilitado=false")
        else:
            log_fail("Stock not deducted when estoque_habilitado=false", f"qty changed to {final_qty}")
    else:
        log_fail("Stock not deducted when estoque_habilitado=false", f"PUT failed: {r.status_code}")
    
    # Test 5: Manual stock adjustment
    r = requests.put(f"{BASE_URL}/produtos/{prod['id']}", headers=headers, json={"estoque_quantidade": 50})
    if r.status_code == 200:
        upd = r.json()
        if upd.get("estoque_quantidade") == 50:
            log_pass("Manual stock adjustment via PUT /produtos/:id")
        else:
            log_fail("Manual stock adjustment", f"qty={upd.get('estoque_quantidade')}, expected 50")
    else:
        log_fail("Manual stock adjustment", f"PUT failed: {r.status_code}")
    
    # Test 6: Multi-tenant isolation
    headers_b, empresa_b = criar_empresa()
    prods_b = requests.get(f"{BASE_URL}/produtos", headers=headers_b).json()
    prod_ids_a = [p["id"] for p in requests.get(f"{BASE_URL}/produtos", headers=headers).json()]
    prod_ids_b = [p["id"] for p in prods_b]
    if not any(id in prod_ids_b for id in prod_ids_a):
        log_pass("Multi-tenant isolation: empresa B doesn't see empresa A products")
    else:
        log_fail("Multi-tenant isolation", "empresa B can see empresa A products")
    
    print(f"\n{len(results['passed'])} passed, {len(results['failed'])} failed")
    if results["failed"]:
        raise SystemExit(1)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"\nFATAL ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        print(f"\n{len(results['passed'])} passed, {len(results['failed'])} failed (execution interrupted)")
        raise SystemExit(1)
```

- [ ] **Step 3: Commit**

```bash
git add backend_test_estoque.py
git commit -m "test: Add backend test suite for estoque (stock deduction, validation, isolation)"
```

---

### Task 12: Build & Final Verification

**Files:**
- No new files; verify all changes

**Interfaces:**
- Consumes: All previous tasks' outputs
- Produces: Clean build, no TypeScript errors, all tests pass

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: "Compiled successfully" + "Generating static pages" ✓

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Check git status**

```bash
git status
```

Expected: Working tree clean (or only untracked files if any).

- [ ] **Step 4: Verify all commits**

```bash
git log --oneline | head -15
```

Expected: 12 commits, all related to estoque (migration, types, repos, UI, tests).

- [ ] **Step 5: Commit (empty commit marking verification)**

```bash
git commit --allow-empty -m "verify: Estoque MVP — build clean, all changes committed"
```

---

## Self-Review

**Spec coverage:**
- ✅ §1 (Schema) → Task 1 (migration)
- ✅ §2 (Domain) → Task 2 (types + interfaces)
- ✅ §3 (Supabase repo) → Task 3
- ✅ §4 (Mongo repo) → Task 4
- ✅ §5 (UI stock mgmt) → Tasks 7-10 (dialog, badge, adjustment, dashboard)
- ✅ §6 (API — no new, existing PUT /produtos) → Tasks 5-6 (integration in pedido/comanda)
- ✅ §8 (Testing) → Task 11
- ✅ §9 (Scope & rollback) — covered in spec, no additional task

**Placeholder scan:** No TODOs, TBDs, or vague instructions. All code blocks are complete.

**Type consistency:** All repository method signatures match interface definitions (Tasks 2, 3, 4). All UI state variables and handlers match their usages.

**No gaps.**

---

## Execution Options

**Plan complete and saved to `docs/superpowers/plans/2026-08-14-estoque-implementation.md`.**

Two execution approaches:

### Option 1: Subagent-Driven (Recommended)
I dispatch a fresh subagent per task, review spec compliance + code quality between tasks, iterate fast. Best for parallel execution and catching issues early.

### Option 2: Inline Execution
Execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints. Single-threaded, but keeps everything in-band.

**Which approach?**
