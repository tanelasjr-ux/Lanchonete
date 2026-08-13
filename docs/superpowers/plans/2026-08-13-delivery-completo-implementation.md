# Delivery Completo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add delivery address, fee, estimated time, and driver assignment to delivery orders.

**Architecture:** 6 new columns in `pedidos` table. New `entregadores` table. Dual-backend repositories (Mongo + Supabase). API endpoints for CRUD and status transitions. Frontend surfaces delivery UI in order dialog and tracking.

**Tech Stack:** Supabase migrations, MongoDB, Node.js repositories, React, TDD in browser.

**Spec:** `docs/superpowers/specs/2026-08-13-delivery-completo-design.md`

## Global Constraints

- 6 columns in `pedidos`: `entrega_endereco`, `entrega_taxa`, `entrega_tempo_estimado_min`, `entregador_id`, `entregador_nome`, `saiu_para_entrega_em` — all with defaults, never null/required for non-delivery
- New `entregadores` table: `id, empresa_id, nome, telefone, ativo, created_at` with RLS by empresa_id
- `PedidoStatus` gains `'saiu_para_entrega'` (canônico, minúsculo)
- Total formula: `total = subtotal - desconto + acrescimo + entrega_taxa`
- `computePedidoValores()` takes 4 params: `(subtotal, desconto, acrescimo, entrega_taxa)`
- Entrega fields always zero/empty for non-delivery; never trust client values
- `entregador_id` validated as owned by empresa (404 if not, never 403)
- Soft-delete only: `ativo = false`; hard-delete never happens

---

### Task 1: Schema — Migration and Domain Types

**Files:**
- Create: `supabase/migrations/0017_delivery.sql`
- Modify: `packages/domain/src/index.ts`

**Produces:** `PedidoStatus` with `'saiu_para_entrega'`; `Pedido` with 6 delivery fields; `Entregador` interface; `EmpresaDeliveryConfig` in `EmpresaConfig`

- [ ] **Step 1: Write migration**

Create `supabase/migrations/0017_delivery.sql` with 6 column ALTERs to `pedidos`, new `entregadores` table, RLS policies, and index on `(empresa_id, ativo)`.

- [ ] **Step 2: Update TypeScript interfaces**

Add `'saiu_para_entrega'` to `PedidoStatus` union. Extend `Pedido` with the 6 fields. Create `Entregador extends TenantScoped` and `EmpresaDeliveryConfig` interfaces. Update `EmpresaConfig` to include optional `delivery` field.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0017_delivery.sql packages/domain/src/index.ts
git commit -m "schema: add delivery columns to pedidos and create entregadores table"
```

---

### Task 2: Repository — Entregador (Supabase)

**Files:**
- Create: `lib/repositories/supabase/entregadorRepository.js`

**Produces:** `EntregadorRepository` with `create()`, `findById()`, `listByEmpresa(empresaId, ativo?)`, `update()`, `updateAtivo()`

- [ ] **Step 1: Implement Supabase EntregadorRepository**

Class with methods for CRUD. `findById()` returns null if not found. `listByEmpresa()` accepts optional `ativo` filter. `update()` is a patch; `updateAtivo()` delegates to it.

- [ ] **Step 2: Commit**

```bash
git add lib/repositories/supabase/entregadorRepository.js
git commit -m "feat: add EntregadorRepository for Supabase backend"
```

---

### Task 3: Repository — Entregador (Mongo)

**Files:**
- Create: `lib/repositories/mongo/entregadorRepository.js`

**Produces:** Same interface as Supabase repo

- [ ] **Step 1: Implement Mongo EntregadorRepository**

Class using MongoDB collection `entregadores`. Normalize Mongo Date to ISO string in `_normalize()` helper. Index: `ensureMongoIndexes()` adds `{ empresa_id: 1, ativo: 1 }`.

- [ ] **Step 2: Register index in factory.js**

In `ensureMongoIndexes(db)`, add `db.collection('entregadores').createIndex({ empresa_id: 1, ativo: 1 })`.

- [ ] **Step 3: Commit**

```bash
git add lib/repositories/mongo/entregadorRepository.js lib/repositories/factory.js
git commit -m "feat: add EntregadorRepository for MongoDB backend"
```

---

### Task 4: Calculation & Factory

**Files:**
- Modify: `app/api/[[...path]]/route.js`, `lib/repositories/factory.js`

**Produces:** `computePedidoValores(sub, desc, acres, taxa)` with taxa. Factory registers `entregadorRepo`.

- [ ] **Step 1: Update `computePedidoValores()` signature**

Add 4th parameter `entregaTaxaEntrada = 0`. Validate `>= 0`. Include in total: `total = sub - desc + acres + taxa`. Update validation: desconto cannot exceed `sub + acres + taxa`.

- [ ] **Step 2: Test calculation in browser**

Create a delivery order. Verify total includes taxa. Edit taxa. Verify total updates. Edit to non-delivery. Verify taxa zeroed.

- [ ] **Step 3: Register repos in factory**

In `buildMongoRepositories()` and `buildSupabaseRepositories()`, instantiate and return `entregadorRepo` alongside others.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js lib/repositories/factory.js
git commit -m "feat: update computePedidoValores to handle entrega_taxa"
```

---

### Task 5: API Endpoints — Entregador CRUD

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Produces:** `GET /entregadores`, `POST /entregadores`, `PUT /entregadores/:id`, `DELETE /entregadores/:id`

- [ ] **Step 1: Implement GET /entregadores**

```javascript
if (route === '/entregadores' && method === 'GET') {
  const { ativo } = query;
  try {
    const list = await repos.entregadorRepo.listByEmpresa(
      usuario.empresa_id,
      ativo === 'true' ? true : ativo === 'false' ? false : undefined
    );
    return json({ entregadores: list });
  } catch (e) { return err(e.message); }
}
```

- [ ] **Step 2: Implement POST /entregadores**

Require GERENTE+ papel. Validate `nome` obrigatório. Call `create()`. Return 201.

- [ ] **Step 3: Implement PUT /entregadores/:id**

Parse ID from route. Require GERENTE+. Build patch from body. Call `update()`. Return updated.

- [ ] **Step 4: Implement DELETE /entregadores/:id (soft-delete)**

Require GERENTE+. Call `updateAtivo(..., false)`. Return 200.

- [ ] **Step 5: Test in browser**

Go to Empresa config. Add entregador. Edit. Deactivate. Verify GET /entregadores reflects changes.

- [ ] **Step 6: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: add CRUD endpoints for entregadores"
```

---

### Task 6: API — Pedido POST/PUT (Delivery Fields)

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Produces:** POST and PUT `/pedidos` accept `entrega_endereco`, `entrega_taxa`, `entrega_tempo_estimado_min`; apply defaults from empresa config; zero-out for non-delivery

- [ ] **Step 1: Update POST /pedidos**

When `tipo === 'delivery'` and fields absent, fetch empresa config and apply defaults. Always zero fields for non-delivery. Pass taxa to `computePedidoValores()`.

- [ ] **Step 2: Update PUT /pedidos/:id**

When changing `tipo`, adjust taxa/endereço accordingly. Pre-fill from cliente.endereco if switching to delivery. Recalculate total.

- [ ] **Step 3: Test in browser**

Create delivery order without entering taxa/tempo → verify defaults apply. Create non-delivery and try to send taxa → verify it's zeroed. Edit order to change tipo → verify fields adjust.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: POST/PUT pedidos handle delivery fields with defaults"
```

---

### Task 7: API — Pedido Status (saiu_para_entrega)

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Produces:** `PATCH /pedidos/:id/status` validates `saiu_para_entrega` transition, requires entregador, snapshots name and timestamp

- [ ] **Step 1: Add status validation**

When status is `saiu_para_entrega`:
- Reject if `tipo !== 'delivery'` (400)
- Require `entregador_id` in body (400 if absent)
- Verify entregador exists and belongs to empresa (404 if not)
- Snapshot: read `entregador_nome` from DB, never from client
- Stamp `saiu_para_entrega_em = now()`

- [ ] **Step 2: Test in browser**

Create delivery order, advance to pronto. Hit "Sair para Entrega", select driver. Verify card shows driver name and elapsed time. Deactivate driver (Task 5 DELETE). Verify old pedidos still show the snapshot name.

- [ ] **Step 3: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: PATCH /pedidos/:id/status handles saiu_para_entrega"
```

---

### Task 8: API — Empresa PUT (Config)

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Produces:** `PUT /empresa` accepts `config.delivery.taxa_padrao` and `.tempo_estimado_min`

- [ ] **Step 1: Add delivery config handling**

In PUT /empresa block, accept and validate `config.delivery`. Validate taxa `>= 0`, tempo `> 0` or null. Update empresa config.

- [ ] **Step 2: Test in browser**

Go to Empresa config. Set taxa to 12, tempo to 50. Save. Create new delivery order → verify defaults are 12 and 50.

- [ ] **Step 3: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: PUT /empresa accepts delivery config"
```

---

### Task 9: UI — Entregadores & Empresa Config

**Files:**
- Modify: `app/page.js`

**Produces:** Empresa screen has Delivery block: taxa/tempo config, inline CRUD for entregadores

- [ ] **Step 1: Add state for delivery config**

`entregadores`, `taxaPadrao`, `tempoEstimadoPadrao`, `novoEntregador` state. Fetch on telaAtiva === 'empresa'.

- [ ] **Step 2: Render delivery config block**

Inputs for taxa and tempo. Button to save. List of entregadores with nome/telefone and Ativo/Inativo toggle. Form to add new entregador.

- [ ] **Step 3: Handler functions**

`handleAdicionarEntregador()`, `handleAtivarDesativarEntregador()`, `handleSalvarConfigDelivery()` call API endpoints.

- [ ] **Step 4: Test in browser**

Enter Empresa config. Add entregador "João" with phone. Toggle ativo. Add another. Edit taxa to 10. Save. Reload. Verify state persists.

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat: UI for delivery config and entregador management"
```

---

### Task 10: UI — Pedido Dialog (Delivery Fields)

**Files:**
- Modify: `app/page.js`

**Produces:** PedidoDialog shows endereço/taxa/tempo fields when tipo === 'delivery'; pre-filled from cliente and config; total includes taxa

- [ ] **Step 1: Add delivery state**

`entregaEndereco`, `entregaTaxa`, `entregaTempoEstimado` state in dialog.

- [ ] **Step 2: Pre-fill on cliente select**

When cliente is selected and tipo is delivery, pre-fill endereço from cliente.endereco. Pre-fill taxa and tempo from empresa config.

- [ ] **Step 3: Render conditional fields**

Show 3 fields only when `tipo === 'delivery'`. Update resumo de valores to show taxa line.

- [ ] **Step 4: Include in save payload**

When saving, only include delivery fields if `tipo === 'delivery'`.

- [ ] **Step 5: Test in browser**

Create new delivery order. Select cliente. Verify endereço, taxa, tempo pre-fill. Edit them. Save. Edit order. Verify fields persist. Change tipo to balcao. Verify delivery fields disappear from form. Save. Reload. Verify tipo is balcao and delivery fields are empty.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "feat: UI for delivery fields in pedido dialog"
```

---

### Task 11: UI — Tela Pedidos (Filter, Cards, Driver Selector)

**Files:**
- Modify: `app/page.js`

**Produces:** Pedidos screen has tipo filter, delivery info on cards, modal to select entregador for saiu_para_entrega

- [ ] **Step 1: Add filter state**

`filtroTipo` state. Filter buttons for "Todas", "Balcão", "Mesa", "Retirada", "Delivery". Only show `filtroTipo === null ? pedidos : pedidos.filter(p => p.tipo === filtroTipo)`.

- [ ] **Step 2: Update pedido cards for delivery**

If tipo is delivery and status is sair_para_entrega, show: endereço (truncated), taxa, entregador name, time elapsed. Highlight if tempo_estimado exceeded (reuse KDS envelhecimento logic).

- [ ] **Step 3: Add entregador selector modal**

When clicking "Sair para Entrega" button on a pronto delivery pedido, open modal. Show list of active entregadores. Let user select. Button to confirm calls PATCH /pedidos/:id/status.

- [ ] **Step 4: Test in browser**

Filter by Delivery. Create delivery order, advance to pronto. Click "Sair para Entrega". Select driver. Verify card updates with driver name and timer. Wait 5 min. If tempo_estimado is 3 min, verify card shows red "ATRASADO".

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat: UI pedidos filter, delivery cards, entregador selector"
```

---

### Task 12: UI — Print & Final Validation

**Files:**
- Modify: `app/page.js`

**Produces:** Cupom includes taxa line and endereço no rodapé. Full workflow validated.

- [ ] **Step 1: Update cupom template**

Add "Taxa de Entrega" line between acrescimo and total. Add "Endereço:" on rodapé for delivery orders.

- [ ] **Step 2: Test print**

Create delivery order with taxa and endereço. Click print. Verify cupom shows taxa line and address.

- [ ] **Step 3: End-to-end test**

1. Create delivery order (tipo not set → balcão)
2. Edit: change tipo to delivery, set endereço
3. Verify taxa and tempo auto-filled from config
4. Advance: recebido → em_preparo → pronto
5. "Sair para Entrega": select driver
6. Verify card shows driver name, elapsed time
7. Print: verify cupom has taxa and endereço
8. Reload page: all fields persist across browser refresh

- [ ] **Step 4: Test multi-tenant**

Logon as different empresa. Entregadores are isolated. Creating pedido with a different empresa's entregador_id returns 404.

- [ ] **Step 5: Test both backends**

Run same test against Supabase and MongoDB. Behavior identical.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "feat: cupom delivery e validação final"
```

---

## Execution Notes

- No automated tests; all validation is manual browser testing per task
- Each task commits immediately; no rollup at the end
- Tasks depend sequentially: Task 4 requires Tasks 2-3 complete (repos); Task 5-8 require Task 4 (factory + calculation)
- UI tasks (9-12) run in parallel on an already-complete backend; coordinate on app.page.js file edits
- At end of Task 12, feature is production-ready: schema live, APIs tested, UI complete
