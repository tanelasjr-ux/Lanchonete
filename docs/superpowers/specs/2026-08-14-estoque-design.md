# Estoque — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement inventory tracking (opt-in per product) with automatic deduction on sale, stock alerts, and manual adjustment UI.

**Architecture:** Stock is tracked at the product level (not item-level in orders). When a pedido or comanda concludes, iterate its items, decrement each product's estoque_quantidade by the quantity sold. Alerts via badges in Produtos screen and dashboard warnings. Manual adjustments via dedicated dialog.

**Tech Stack:** Supabase schema extension (3 new columns), React UI (badges + dialog), service layer logic (Transaction pattern).

---

## Global Constraints

- **Multi-tenant isolation via empresa_id** (all queries filtered by tenant)
- **Soft-delete pattern:** `ativo` column gates access; `estoque_habilitado` opt-in per product
- **Numeric precision:** Stock quantities as `numeric(12,2)` (allows fractional units: 0.5 kg salt, 2.75 L oil)
- **RLS:** Supabase enables row-level security; Mongo enforced by application layer (`empresa_id` filter)
- **Audit trail:** `auditoria` logs all stock adjustments (create/update/delete)

---

## 1. Schema Extension (Migration 0019)

### Products Table Addition

```sql
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_habilitado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_quantidade NUMERIC(12,2) DEFAULT NULL;
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS estoque_minimo NUMERIC(12,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_produtos_estoque_habilitado ON public.produtos(empresa_id, estoque_habilitado) WHERE estoque_habilitado = true;
```

**Rationale:**
- `estoque_habilitado`: Opt-in flag. Only products with this=true participate in stock tracking. Defaults `false` to avoid breaking existing workflows.
- `estoque_quantidade`: Current stock level. Null = not configured (acts as "not enabled" for products where flag is false).
- `estoque_minimo`: Threshold for alerts. Stored here (not in config) so each product has its own trigger point.
- Index on `(empresa_id, estoque_habilitado)` speeds up "give me all tracked products" queries (dashboard, alerts).

**No new tables.** Stock movements are NOT logged as separate transações — they are recorded in `auditoria` as "estoque_ajuste" entries. This keeps the data model lean: stock is a denormalized snapshot on products, not a ledger.

---

## 2. Domain Contracts (packages/domain/src/index.ts)

```typescript
export interface Produto extends TenantScoped {
  // ... existing fields ...
  estoque_habilitado: boolean;
  estoque_quantidade: number | null;
  estoque_minimo: number;
}

export interface EstoqueAjuste {
  produto_id: UUID;
  empresa_id: UUID;
  quantidade_anterior: number;
  quantidade_nova: number;
  motivo: string; // 'venda', 'devolucao', 'ajuste_manual', 'sucata'
  usuario_id: UUID;
  data: Date;
}

export interface ProdutoRepository extends Repository<Produto>, BulkCreatable<Produto> {
  // ... existing methods ...
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

**Rationale:**
- `decrementarEstoque()` is called during sale completion (pedido/comanda). Validates that new quantity ≥ 0; if not, returns error (hard-block: "out of stock").
- `ajustarEstoque()` is for manual corrections (physical count mismatch). Does NOT decrement — sets to the corrected value directly.
- `listEstoqueBaixo()` powers the dashboard alerts and inventory warning badge.
- Separate methods (not a generic `update()`) to keep business logic clear and auditable.

---

## 3. Service Layer: Stock Deduction on Sale

### Integration Points

**A. When Pedido concludes (`PUT /pedidos/:id` with status='concluido' or 'ENTREGUE'):**

```javascript
// app/api/route.js, after transacao is created (line ~1355)
if (finais.includes(b.status) && !finais.includes(pedido.status)) {
  // ... existing: create transacao, increment cliente metricas ...
  
  // NEW: Decrement stock for each item sold
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
        // Stock error is NOT fatal — log and continue. Order already concluded.
        // Restaurante can reconcile stock manually if product inventory runs negative.
        console.warn(`Stock deduction failed for produto ${item.produto_id}: ${e.message}`)
        await audit(repos, ctx, 'estoque_erro', 'pedido', pedido.id, { erro: e.message })
      }
    }
  }
}
```

**B. When Comanda closes (`POST /comandas/:id/fechar`):**

```javascript
// app/api/route.js, after pedido is created (line ~1907)
// Same logic: iterate items, decrement stock
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

**Rationale:**
- Both flows converge: pedido + comanda both create transactions and decrement stock.
- Stock errors are non-fatal. Order completion is business-critical; stock is secondary. If stock deduction fails (e.g., config error, FK violation), the sale still completes and stock is logged as "erro" in audit for manual reconciliation.
- `motivo='venda'` distinguishes from other adjustments (devolução, sucata, ajuste_manual).

---

## 4. Repositories (Supabase + Mongo)

### Supabase Implementation (lib/repositories/supabase/produtoRepository.js)

```javascript
async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
  // RLS + tenant isolation enforced by Supabase
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (!atual.estoque_habilitado) {
    // Product has stock tracking disabled — silent success (no-op)
    return atual
  }
  
  const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)
  
  // Hard block: cannot go negative
  if (novaQuantidade < 0) {
    throw new Error(`Estoque insuficiente: ${atual.nome} (tinha ${atual.estoque_quantidade}, tentou vender ${quantidade})`)
  }
  
  const updated = await supabase
    .from('produtos')
    .update({
      estoque_quantidade: novaQuantidade,
      updated_at: new Date().toISOString(),
    })
    .eq('id', produtoId)
    .eq('empresa_id', empresaId)
    .select()
    .maybeSingle()
  
  if (!updated) throw new Error('Falha ao atualizar estoque')
  return this._normalize(updated)
}

async ajustarEstoque(empresaId, produtoId, novaQuantidade, motivo) {
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (novaQuantidade < 0) throw new Error('Quantidade nao pode ser negativa')
  
  const updated = await supabase
    .from('produtos')
    .update({
      estoque_quantidade: Number(novaQuantidade),
      updated_at: new Date().toISOString(),
    })
    .eq('id', produtoId)
    .eq('empresa_id', empresaId)
    .select()
    .maybeSingle()
  
  if (!updated) throw new Error('Falha ao atualizar estoque')
  return this._normalize(updated)
}

async listEstoqueBaixo(empresaId) {
  const { data, error } = await supabase
    .from('produtos')
    .select('*')
    .eq('empresa_id', empresaId)
    .eq('estoque_habilitado', true)
    .lte('estoque_quantidade', 'estoque_minimo')
    .order('estoque_quantidade', { ascending: true })
  
  return unwrap(data, error).map(p => this._normalize(p))
}

async getEstoque(empresaId, produtoId) {
  const p = await this.findById(empresaId, produtoId)
  return p?.estoque_quantidade || null
}
```

### Mongo Implementation (lib/repositories/mongo/produtoRepository.js)

Identical interface; uses MongoDB update operators:

```javascript
async decrementarEstoque(empresaId, produtoId, quantidade, motivo) {
  const col = db.collection('produtos')
  const atual = await this.findById(empresaId, produtoId)
  if (!atual) throw new Error('Produto nao encontrado')
  
  if (!atual.estoque_habilitado) return atual
  
  const novaQuantidade = (atual.estoque_quantidade || 0) - Number(quantidade)
  if (novaQuantidade < 0) {
    throw new Error(`Estoque insuficiente: ${atual.nome}`)
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
}

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
}
```

---

## 5. UI: Stock Management

### A. Produtos Screen — Product Dialog (app/page.js)

**Add to product create/edit dialog:**

```jsx
<div className="space-y-3">
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

### B. Produtos List — Stock Badge

**Add badge to product card:**

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
    {p.estoque_quantidade} {p.unidade || 'un'}
  </Badge>
)}
```

**Colors:**
- **Red:** `estoque_quantidade <= estoque_minimo` (CRÍTICO: out or near out)
- **Amber:** `estoque_quantidade <= 1.5 × estoque_minimo` (AVISO: reorder soon)
- **Green:** above 1.5×minimum (OK)

### C. Stock Adjustment Modal

**New dialog on Produtos screen (accessible from menu):**

```jsx
const [ajustarDlg, setAjustarDlg] = useState(null) // { produto_id, nome, quantidade_atual }

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
          onChange={(e) => setAjustarForm({ ...ajustarForm, novaQuantidade: Number(e.target.value) })}
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

**Handler:**

```javascript
const handleAjustar = async () => {
  try {
    await api(`/produtos/${ajustarDlg.produto_id}`, {
      method: 'PUT',
      body: {
        estoque_quantidade: ajustarForm.novaQuantidade,
      },
    })
    // Log adjustment in audit (backend handles via audit() call in route.js)
    toast.success('Estoque ajustado')
    setAjustarDlg(null)
    carregarProdutos() // Reload to see new badge color
  } catch (e) {
    toast.error(e.message)
  }
}
```

### D. Dashboard Warning (app/page.js — Dashboard component)

**Add section to show low-stock products:**

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
            <span className="font-mono">{p.estoque_quantidade} / {p.estoque_minimo} min</span>
          </div>
        ))}
      </div>
    </CardContent>
  </Card>
)}
```

**Load on dashboard mount:**

```javascript
const [estoqueBaixo, setEstoqueBaixo] = useState([])

useEffect(() => {
  const carregarEstoqueBaixo = async () => {
    try {
      const prods = await api('/produtos')
      const baixo = prods.filter(p => p.estoque_habilitado && p.estoque_quantidade <= p.estoque_minimo)
      setEstoqueBaixo(baixo)
    } catch (e) { /* silent */ }
  }
  carregarEstoqueBaixo()
}, [])
```

---

## 6. API Endpoints

No new endpoints. Stock updates happen via:

1. **PUT /produtos/:id** — Update product fields (existing endpoint, now accepts `estoque_habilitado`, `estoque_quantidade`, `estoque_minimo`)
2. **GET /produtos** — List products (existing; returns new fields)

Backend handles stock deduction automatically in:
- `PUT /pedidos/:id` (when status changes to 'concluido' or 'ENTREGUE')
- `POST /comandas/:id/fechar` (when comanda closes)

---

## 7. Error Handling & Validation

**At decrementarEstoque():**
- If `estoque_habilitado=false`, no-op (return unchanged product). Silent success.
- If `novaQuantidade < 0`, throw error with message: `"Estoque insuficiente: {nome} (tinha {atual}, tentou vender {qty})"`
- Error is caught in route.js, logged to audit as `estoque_erro`, and order still completes (non-fatal).

**At ajustarEstoque():**
- If `novaQuantidade < 0`, throw error: `"Quantidade nao pode ser negativa"`
- This is a user-initiated action, so error bubbles to UI (toast.error).

**Stock integrity:**
- Fractional quantities are allowed (e.g., 2.5 kg, 0.75 L).
- No locking needed: Supabase RLS + `empresa_id` filter provides isolation.
- Mongo relies on application-layer `empresa_id` checks (factory pattern already enforces).

---

## 8. Testing

**Manual test flows:**

1. **Create product with stock tracking enabled**
   - Product Produtos screen, toggle "Rastrear Estoque"
   - Set quantity=10, minimum=3
   - Save; verify badge shows "10 un" (green)

2. **Sell product, verify deduction**
   - Create pedido with this product (qty=2)
   - Mark pedido as concluído
   - Reload Produtos; verify quantity=8

3. **Low stock alert**
   - Sell 6 more (qty total 8 in 3 pedidos)
   - Quantity now 2 (below minimum of 3)
   - Badge turns amber (1.5×minimum = 4.5)
   - Badge turns red (at minimum)

4. **Manual adjustment**
   - Click "Ajustar Estoque" on a product
   - Set new quantity=15, motivo="Devolução do cliente"
   - Verify badge updates; verify audit log

5. **Multi-tenant isolation**
   - Login as empresa B
   - Create products; verify empresa A's stock not visible

**Automated tests (backend_test_estoque.py):**

```python
def test_stock_deduction_on_pedido_concluido():
    """Verify stock decrements when pedido status changes to concluido."""
    
def test_stock_deduction_on_comanda_fechar():
    """Verify stock decrements when comanda is closed."""
    
def test_stock_insufficient_error():
    """Verify hard-block when stock insufficient."""
    
def test_estoque_habilitado_false_no_deduction():
    """Verify no deduction if estoque_habilitado=false."""
    
def test_estoque_baixo_alert():
    """Verify listEstoqueBaixo returns correct products."""
    
def test_multi_tenant_isolation():
    """Verify empresa B cannot see empresa A's stock."""
```

---

## 9. Scope & Non-Goals

**In MVP:**
- Stock tracking is opt-in per product (not system-wide enforcement).
- Stock errors are non-fatal (don't block sales).
- No barcode/QR scanning (can add later).
- No stock transfers between locations (single location per empresa).
- No supplier integration (manual reorder).

**Future (Post-MVP):**
- Reorder level automation (trigger n8n workflow when stock < minimum).
- Stock history/ledger (detailed "received 20 units on 2026-08-15" log).
- Variance reports (physical count vs. system count).
- Multi-location stock (distribuição entre filiais).

---

## 10. Rollback & Data Safety

**Migration is non-destructive:**
- All new columns have `DEFAULT` values; existing products unaffected.
- `estoque_habilitado` defaults to `false` — zero behavior change on day 1.
- Index addition is transparent (no locking on table).

**Rollback:** Drop columns and indices (migration 0020 if needed). Existing data safe.

**No data loss in any scenario.**
