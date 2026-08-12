# KDS + Status pelo Celular Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cozinha um painel de pedidos pendentes (TV passiva ou com toque) e dar ao atendente um jeito, pelo celular, de marcar itens como prontos — fechando o ciclo para que o painel nunca acumule itens já entregues.

**Architecture:** Segue a cadeia existente Route (catch-all `app/api/[[...path]]/route.js`) -> Service (mesmo arquivo) -> Repository (`lib/repositories/{mongo,supabase}/`) -> Database, com o switch de provider já existente em `lib/repositories/factory.js`. Frontend continua o SPA de página única (`app/page.js`), com o KDS extraído para `components/kds.jsx` (mesmo padrão de extração já usado por `components/cupom.jsx`). Nenhuma rota Next.js nova — a TV usa um query param na raiz.

**Tech Stack:** Next.js App Router, MongoDB + Supabase (dual-backend via `DATABASE_PROVIDER`), Postgres/Supabase migrations SQL puro, React (sem framework de state management), shadcn/ui, Python (`requests`) para teste de integração de backend.

## Global Constraints

- Toda entidade/consulta multi-tenant é escopada por `empresa_id` — sem exceção, nas duas camadas (aplicação + RLS). Ver `CLAUDE.md` §5.
- Regra de negócio só no Service (dentro de `route.js`); repository só faz acesso a dado. Ver `docs/ARCHITECTURE.md` ADR-006.
- Toda mudança em `pedidos`/`comanda_itens` via função RPC com lista de colunas explícita precisa reescrever a função se a coluna mudar (armadilha 4 do `HANDOFF.md`) — **não se aplica a este plano**: nenhuma coluna nova entra em `pedidos`/`pedido_itens`.
- Migrations não destrutivas podem rodar de forma autônoma (`CLAUDE.md` §4). A migration deste plano é 100% aditiva (`add column if not exists`, `create table`).
- Design de referência: `docs/plans/KDS-DESIGN.md` — todo task abaixo implementa uma seção específica dele; consulte se um detalhe parecer ambíguo.

---

### Task 1: Migration `0016_kds.sql`

**Files:**
- Create: `supabase/migrations/0016_kds.sql`

**Interfaces:**
- Produces: coluna `comanda_itens.entregue boolean not null default false`; tabela `kds_tokens(id, empresa_id, token, modo, criado_em, revogado_em)` com RLS.

- [ ] **Step 1: Escrever a migration**

```sql
-- ============================================================================
-- Restaurant OS :: Migration 0016 :: KDS (tela de cozinha) + status pelo celular
-- ----------------------------------------------------------------------------
-- Duas mudancas aditivas, nao destrutivas, que nascem juntas para esta
-- feature (ver docs/plans/KDS-DESIGN.md):
--
-- 1) comanda_itens.entregue: unico gap real de dado encontrado no design.
--    Pedidos de balcao/delivery/retirada ja tem status completo
--    (pedidos.status); itens de comanda (mesa) nao tinham NENHUM sinal de
--    "ja saiu da cozinha". Booleano, nao enum - o KDS so distingue pendente
--    de concluido, um vocabulario maior seria complexidade sem uso.
--
-- 2) kds_tokens: acesso da TV sem login de usuario. `modo` decide se aquele
--    link especifico pode so ler (`leitura`, TV comum) ou tambem concluir
--    itens (`toque`, tablet/TV touchscreen) - escolhido por link, nao
--    globalmente, porque a mesma empresa pode ter os dois hardwares ao
--    mesmo tempo.
-- ============================================================================

alter table public.comanda_itens
  add column if not exists entregue boolean not null default false;
create index if not exists idx_comanda_itens_pendentes
  on public.comanda_itens(empresa_id, comanda_id) where not entregue;

create table if not exists public.kds_tokens (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  token       text not null unique,
  modo        text not null default 'leitura' check (modo in ('leitura','toque')),
  criado_em   timestamptz not null default now(),
  revogado_em timestamptz
);
create index if not exists idx_kds_tokens_token on public.kds_tokens(token) where revogado_em is null;
create index if not exists idx_kds_tokens_empresa on public.kds_tokens(empresa_id);

alter table public.kds_tokens enable row level security;
drop policy if exists kds_tokens_tenant on public.kds_tokens;
create policy kds_tokens_tenant on public.kds_tokens
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
```

- [ ] **Step 2: Aplicar contra o Supabase real**

Seguir o método já documentado no `HANDOFF.md` §5.1 (não há `psql` instalado
na máquina; a senha do banco tem `@` que precisa virar `%40` na connection
string):

```bash
docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" < supabase/migrations/0016_kds.sql
```

- [ ] **Step 3: Verificar que a coluna e a tabela existem**

```bash
docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" -c "\d comanda_itens" -c "\d kds_tokens"
```

Esperado: `comanda_itens` lista a coluna `entregue` (`boolean`, `not null`,
default `false`); `kds_tokens` existe com as 6 colunas e RLS habilitado.

- [ ] **Step 4: Atualizar `README.md` com a ordem de migrations**

Adicionar `-> 0016_kds` ao final da cadeia documentada (mesmo padrão do
`HANDOFF.md` §4.3).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0016_kds.sql README.md
git commit -m "feat(supabase): migration 0016 - status de entrega em comanda_itens e kds_tokens"
```

---

### Task 2: Contratos de domínio e repositório Mongo — `comanda_itens.entregue`

**Files:**
- Modify: `packages/domain/src/index.ts:116-122` (interface `ComandaItem`)
- Modify: `packages/domain/src/index.ts:331` (tipo do patch de `updateItemCampos`)
- Modify: `lib/repositories/mongo/comandaRepository.js:32-37` (`updateItemCampos`)

**Interfaces:**
- Consumes: nenhuma (mudança isolada em contrato + repositório).
- Produces: `ComandaItem.entregue: boolean`; `updateItemCampos(empresaId, comandaId, itemId, patch: Partial<Pick<ComandaItem, 'quantidade'|'observacao'|'entregue'>>)` aceitando `entregue` nos dois backends.

- [ ] **Step 1: Adicionar `entregue` ao contrato `ComandaItem`**

Em `packages/domain/src/index.ts`, editar a interface (linha 116-122):

```typescript
export interface ComandaItem {
  id: UUID; comanda_id: UUID; produto_id: UUID | null;
  nome: string; preco: number; quantidade: number;
  desconto: number; observacao: string; subtotal: number;
  operador_id: UUID | null; operador_nome: string | null;
  created_at: string;
  /** Marcado pelo atendente (celular) ou pela TV em modo toque quando o item sai da cozinha. */
  entregue: boolean;
}
```

- [ ] **Step 2: Ampliar o tipo do patch em `ComandaRepository.updateItemCampos`**

Linha 331, trocar:

```typescript
updateItemCampos(empresaId: UUID, comandaId: UUID, itemId: UUID, patch: Partial<Pick<ComandaItem, 'quantidade' | 'observacao'>>): Promise<void>;
```

por:

```typescript
updateItemCampos(empresaId: UUID, comandaId: UUID, itemId: UUID, patch: Partial<Pick<ComandaItem, 'quantidade' | 'observacao' | 'entregue'>>): Promise<void>;
```

- [ ] **Step 3: Adicionar `entregue` ao whitelist do Mongo repository**

Em `lib/repositories/mongo/comandaRepository.js`, a função `updateItemCampos`
(linha 32-37) usa uma lista de campos explícita — sem isso, `entregue` seria
descartado em silêncio (mesma classe de bug já documentada na armadilha 4 do
`HANDOFF.md`, ainda que aqui seja em JS, não em `jsonb_populate_record`):

```javascript
updateItemCampos(empresaId, comandaId, itemId, patch) {
  const set = {}
  if (patch.quantidade !== undefined) set['itens.$.quantidade'] = patch.quantidade
  if (patch.observacao !== undefined) set['itens.$.observacao'] = patch.observacao
  if (patch.entregue !== undefined) set['itens.$.entregue'] = patch.entregue
  return col.updateOne({ id: comandaId, empresa_id: empresaId, 'itens.id': itemId }, { $set: set })
},
```

O lado Supabase (`lib/repositories/supabase/comandaRepository.js:62-64`) já
repassa o patch inteiro para `.update(patch)` sem whitelist — **não precisa
mudar**, o Postgres já aceita a coluna nova.

- [ ] **Step 4: Verificar manualmente via Mongo local**

```bash
docker start ros-mongo-local
corepack enable
yarn dev:no-reload
```

Em outro terminal, com um token válido (`ros_token` de um usuário de teste)
e um item de comanda existente:

```bash
curl -X PUT http://localhost:3000/api/comandas/<comanda_id>/itens/<item_id> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"entregue": true}'
```

Esperado: resposta 200 com a comanda atualizada, item com `entregue: true`.
Repetir contra `DATABASE_PROVIDER=supabase` para confirmar paridade entre
backends (regra do projeto: os dois sempre satisfazem o mesmo contrato).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/index.ts lib/repositories/mongo/comandaRepository.js
git commit -m "feat(comanda): adiciona campo entregue por item (base para o KDS)"
```

---

### Task 3: `kdsTokenRepository` (Mongo + Supabase) e fábrica

**Files:**
- Create: `lib/repositories/mongo/kdsTokenRepository.js`
- Create: `lib/repositories/supabase/kdsTokenRepository.js`
- Modify: `lib/repositories/factory.js`

**Interfaces:**
- Produces: `kdsTokenRepo` com `create(entity)`, `findByToken(token)`,
  `listByEmpresa(empresaId)`, `revoke(empresaId, id)` — disponível em
  `repos.kdsTokenRepo` para o `route.js` usar na Task 5/6. `entity` é
  construído pelo chamador (Service), como todo `create()` já existente
  neste projeto — o repository nunca gera `id`/`token`, só persiste.

- [ ] **Step 1: Repository Mongo**

`kds_tokens` é infra técnica (token de acesso, não entidade de domínio que
um usuário do negócio pensaria — mesmo raciocínio já registrado para
`webhook_events`, `lib/repositories/mongo/webhookEventsRepository.js`), por
isso fica fora do `Repository<T>` do `domain.ts`:

```javascript
/**
 * Infra tecnica (token de acesso da TV do KDS), sem contrato em domain.ts -
 * mesmo espirito de webhookEventsRepository.js.
 */
export function createKdsTokenRepository(database) {
  const col = database.collection('kds_tokens')
  return {
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    findByToken(token) {
      return col.findOne({ token })
    },
    listByEmpresa(empresaId) {
      return col.find({ empresa_id: empresaId }).sort({ criado_em: -1 }).toArray()
    },
    async revoke(empresaId, id) {
      await col.updateOne({ id, empresa_id: empresaId }, { $set: { revogado_em: new Date() } })
      return col.findOne({ id, empresa_id: empresaId })
    },
  }
}
```

- [ ] **Step 2: Repository Supabase**

```javascript
import { unwrap } from './_shared.js'

/**
 * Contrapartida Mongo de lib/repositories/mongo/kdsTokenRepository.js.
 */
export function createKdsTokenRepository(supabase) {
  return {
    async create(entity) {
      return unwrap(await supabase.from('kds_tokens').insert(entity).select().single())
    },
    async findByToken(token) {
      return unwrap(await supabase.from('kds_tokens').select('*').eq('token', token).maybeSingle())
    },
    async listByEmpresa(empresaId) {
      return unwrap(await supabase.from('kds_tokens').select('*').eq('empresa_id', empresaId).order('criado_em', { ascending: false }))
    },
    async revoke(empresaId, id) {
      return unwrap(await supabase.from('kds_tokens').update({ revogado_em: new Date().toISOString() }).eq('id', id).eq('empresa_id', empresaId).select().maybeSingle())
    },
  }
}
```

- [ ] **Step 3: Registrar na fábrica**

Em `lib/repositories/factory.js`, seguir exatamente o padrão de
`webhookEventsRepo` (que também não tem contrato em `domain.ts`):

Adicionar aos imports Mongo (perto da linha 38):
```javascript
import { createKdsTokenRepository as mongoKdsToken } from './mongo/kdsTokenRepository'
```

Adicionar aos imports Supabase (perto da linha 55):
```javascript
import { createKdsTokenRepository as sbKdsToken } from './supabase/kdsTokenRepository'
```

Em `buildMongoRepositories` (linha 110-129), adicionar:
```javascript
kdsTokenRepo: mongoKdsToken(database),
```

Em `buildSupabaseRepositories` (linha 133-152), adicionar:
```javascript
kdsTokenRepo: sbKdsToken(supabase),
```

- [ ] **Step 4: Verificar que a fábrica ainda inicializa sem erro**

```bash
yarn dev:no-reload
curl http://localhost:3000/api/health
```

Esperado: `{"status":"ok", ...}` (ou `degraded` só se faltar variável de
ambiente pré-existente — nada relacionado a `kds_tokens` deve quebrar o
health check, já que a fábrica só monta os repositories, não valida
schema).

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/mongo/kdsTokenRepository.js lib/repositories/supabase/kdsTokenRepository.js lib/repositories/factory.js
git commit -m "feat(kds): repository de token da TV (Mongo + Supabase)"
```

---

### Task 4: Mover `normPedidoStatus` para escopo do módulo

**Files:**
- Modify: `app/api/[[...path]]/route.js:1356-1364` (remover definição local)
- Modify: `app/api/[[...path]]/route.js` (nova definição em escopo de módulo, perto de `can()`)

**Interfaces:**
- Produces: `normPedidoStatus(status: string): 'novo'|'em_preparacao'|'pronto'|'saiu'|'entregue'|'cancelado'`, chamável por qualquer rota do arquivo (hoje só é chamável depois da linha 1356, porque é uma `const` declarada dentro do corpo de `handler()`, não do módulo).

Pré-requisito da Task 5: o endpoint `GET /kds/pendentes` fica **antes** da
linha 597 (portão de autenticação) e precisa dessa função. Sem mover,
referenciá-la ali lançaria `ReferenceError` (temporal dead zone de uma
`const` declarada mais adiante no mesmo escopo de função).

- [ ] **Step 1: Remover a definição local**

Em `app/api/[[...path]]/route.js`, apagar as linhas 1356-1364 (a `const
normPedidoStatus = (s) => {...}` que hoje vive logo antes do comentário
`/* ==================== ATENDIMENTO / CONVERSAS ==================== */`).

- [ ] **Step 2: Recriar em escopo de módulo**

Logo após a função `can()` (linha 124-127), antes do comentário `/*
============================ HTTP HELPERS
============================= */` (linha 129):

```javascript
/**
 * Normaliza o vocabulario duplo de pedidos.status (minusculo original +
 * MAIUSCULO do fluxo de atendimento/delivery v3 - ver migration 0002).
 * Em escopo de modulo (nao dentro de handler()) porque tanto rotas
 * autenticadas quanto o endpoint publico /kds/pendentes precisam dela.
 */
function normPedidoStatus(s) {
  if (['recebido', 'NOVO', 'CONFIRMADO'].includes(s)) return 'novo'
  if (['em_preparo', 'EM_PREPARACAO'].includes(s)) return 'em_preparacao'
  if (['pronto', 'PRONTO'].includes(s)) return 'pronto'
  if (['SAIU_PARA_ENTREGA'].includes(s)) return 'saiu'
  if (['concluido', 'ENTREGUE'].includes(s)) return 'entregue'
  if (['cancelado', 'CANCELADO'].includes(s)) return 'cancelado'
  return 'novo'
}
```

- [ ] **Step 3: Rodar a suite de regressão existente**

```bash
docker start ros-mongo-local
yarn dev:no-reload
```

Em outro terminal:
```bash
PYTHONIOENCODING=utf-8 python backend_test.py
PYTHONIOENCODING=utf-8 python backend_test_v3.py
```

Esperado: mesma contagem de passes que o baseline documentado no
`HANDOFF.md` §7.1 (v1: 40/40, v3: 32/33 com a falha conhecida de
`tipo:'conversation'`). Nenhuma regressão nova — a função só mudou de
escopo, o comportamento é idêntico. `/conversas/metrics` (que já usava essa
função) precisa continuar respondendo igual.

- [ ] **Step 4: Commit**

```bash
git add app/api/\[\[...path\]\]/route.js
git commit -m "refactor(pedidos): move normPedidoStatus para escopo de modulo"
```

---

### Task 5: Endpoints `GET /kds/pendentes` e `POST /kds/concluir`

**Files:**
- Modify: `app/api/[[...path]]/route.js` (inserir bloco novo imediatamente
  antes da linha `/* ---- a partir daqui, tudo autenticado ---- */`, hoje
  linha 597 — depois da Task 4 o número de linha pode ter mudado poucas
  linhas; localizar pelo texto do comentário, não pelo número)
- Modify: `app/api/[[...path]]/route.js` (destructuring de `repos` no topo
  de `handler()`, linha 433-437, adicionar `kdsTokenRepo`)

**Interfaces:**
- Consumes: `repos.kdsTokenRepo` (Task 3), `repos.pedidoRepo`,
  `repos.comandaRepo`, `repos.usuarioRepo` (já existentes),
  `normPedidoStatus()` (Task 4), `can()`, `auth()`, `audit()`, `clean()`,
  `json()`, `err()` (já existentes no arquivo).
- Produces: `GET /kds/pendentes` -> `{ itens: [...], modo: 'leitura'|'toque'|null }`;
  `POST /kds/concluir` -> `{ ok: true }`. Consumidos pelo frontend na Task 7.

- [ ] **Step 1: Adicionar `kdsTokenRepo` ao destructuring de repos**

Linha 433-437, trocar:

```javascript
const {
  categoriaRepo, produtoRepo, clienteRepo, usuarioRepo, transacaoRepo,
  auditoriaRepo, integracaoRepo, mesaRepo, conversaRepo, mensagemRepo,
  pedidoRepo, comandaRepo, pagamentoRepo, empresaRepo, webhookEventsRepo,
} = repos
```

por:

```javascript
const {
  categoriaRepo, produtoRepo, clienteRepo, usuarioRepo, transacaoRepo,
  auditoriaRepo, integracaoRepo, mesaRepo, conversaRepo, mensagemRepo,
  pedidoRepo, comandaRepo, pagamentoRepo, empresaRepo, webhookEventsRepo,
  kdsTokenRepo,
} = repos
```

- [ ] **Step 2: Escrever o bloco de rotas, antes do portão de autenticação**

Localizar o comentário `/* ---- a partir daqui, tudo autenticado ---- */`
(hoje linha 597) e inserir imediatamente **antes** dele:

```javascript
    /* ==================== KDS (leitura/acao publica via token OU JWT) ====================
     * Fica ANTES do portao de autenticacao padrao de proposito: a TV nao
     * loga como usuario (docs/plans/KDS-DESIGN.md §5.4). resolveKdsAuth()
     * aceita Bearer JWT normal (celular do atendente, ou COZINHA pelo
     * navegador) OU ?tv_token=... (TV, sem login).
     */
    const resolveKdsAuth = async () => {
      const url = new URL(request.url)
      const tvToken = url.searchParams.get('tv_token')
      if (tvToken) {
        const rec = await kdsTokenRepo.findByToken(tvToken)
        if (!rec || rec.revogado_em) return null
        return { empresa_id: rec.empresa_id, modo: rec.modo, isTv: true, usuario_id: null, nome: 'TV Cozinha' }
      }
      const session = await auth(request)
      if (!session) return null
      const usuario = await usuarioRepo.findById(session.empresa_id, session.usuario_id)
      if (!usuario || !usuario.ativo) return null
      return { empresa_id: session.empresa_id, usuario_id: usuario.id, papel: usuario.papel, nome: usuario.nome, isTv: false }
    }

    if (route === '/kds/pendentes' && method === 'GET') {
      const kctx = await resolveKdsAuth()
      if (!kctx) return err('Nao autorizado', 401)
      if (!kctx.isTv && !can(kctx.papel, 'pedidos')) return err('Sem permissao', 403)

      const [pedidos, comandas] = await Promise.all([
        pedidoRepo.list(kctx.empresa_id),
        comandaRepo.list(kctx.empresa_id, { status: 'aberta' }),
      ])
      const pedidosPendentes = pedidos
        .filter((p) => ['novo', 'em_preparacao'].includes(normPedidoStatus(p.status)))
        .map((p) => ({
          origem: 'pedido', id: p.id, numero: p.numero, tipo: p.tipo,
          itens: (p.itens || []).map((it) => ({ nome: it.nome, quantidade: it.quantidade, observacao: it.observacao || '' })),
          created_at: p.created_at,
        }))
      const itensMesaPendentes = comandas.flatMap((c) => (c.itens || [])
        .filter((it) => !it.entregue)
        .map((it) => ({
          origem: 'mesa', id: it.id, comanda_id: c.id, mesa_nome: c.mesa_nome,
          nome: it.nome, quantidade: it.quantidade, observacao: it.observacao || '',
          created_at: it.created_at,
        })))
      const itens = [...pedidosPendentes, ...itensMesaPendentes]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      return json({ itens, modo: kctx.isTv ? kctx.modo : null })
    }

    if (route === '/kds/concluir' && method === 'POST') {
      const kctx = await resolveKdsAuth()
      if (!kctx) return err('Nao autorizado', 401)
      const b = (await request.json()) || {}
      if (!['pedido', 'mesa'].includes(b.origem) || !b.id) return err('Campos obrigatorios: origem, id')
      if (b.origem === 'mesa' && !b.comanda_id) return err('Campo obrigatorio: comanda_id')

      if (kctx.isTv) {
        if (kctx.modo !== 'toque') return err('Este link e somente leitura', 403)
      } else {
        const permNecessaria = b.origem === 'pedido' ? 'pedidos' : 'mesas'
        if (!can(kctx.papel, permNecessaria)) return err('Sem permissao', 403)
      }

      if (b.origem === 'pedido') {
        const pedido = await pedidoRepo.findById(kctx.empresa_id, b.id)
        if (!pedido) return err('Pedido nao encontrado', 404)
        await pedidoRepo.update(kctx.empresa_id, b.id, { status: 'pronto', updated_at: new Date() })
      } else {
        await comandaRepo.updateItemCampos(kctx.empresa_id, b.comanda_id, b.id, { entregue: true })
      }
      await audit(repos, { empresa_id: kctx.empresa_id, usuario_id: kctx.usuario_id, nome: kctx.nome }, 'concluir', b.origem === 'pedido' ? 'pedido' : 'comanda_item', b.id, {})
      return json({ ok: true })
    }

```

- [ ] **Step 3: Escrever o teste de integração (novo arquivo)**

Criar `backend_test_kds.py`, seguindo exatamente o estilo de
`backend_test.py` (mesmo `BASE_URL`, `log_pass`/`log_fail`, tenants A/B para
isolamento):

```python
#!/usr/bin/env python3
"""
Restaurant OS - KDS Test Suite
Cobre: GET /kds/pendentes, POST /kds/concluir, isolamento multi-tenant,
tokens da TV (gerar/listar/revogar), modo leitura vs toque.
"""

import requests
import random
import string
import os

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

results = {"passed": [], "failed": [], "critical_failures": []}

def log_pass(test_name):
    print(f"PASS: {test_name}")
    results["passed"].append(test_name)

def log_fail(test_name, reason, critical=False):
    print(f"FAIL: {test_name}")
    print(f"   Reason: {reason}")
    results["failed"].append({"test": test_name, "reason": reason})
    if critical:
        results["critical_failures"].append({"test": test_name, "reason": reason})

def random_email():
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"kds.{rand}@teste.com"

def registrar_tenant(nome_empresa):
    email = random_email()
    resp = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome_empresa, "nome": "Dono Teste", "email": email, "senha": "senha_123456"
    })
    assert resp.status_code == 200, f"register falhou: {resp.text}"
    data = resp.json()
    return {"token": data["token"], "empresa": data["empresa"], "usuario": data["usuario"]}

try:
    print("Setup: registrando tenant A e B...")
    a = registrar_tenant("KDS Teste A")
    b = registrar_tenant("KDS Teste B")
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    # Precisa de ao menos um produto para criar pedido/comanda com item.
    def criar_produto(headers):
        resp = requests.post(f"{BASE_URL}/categorias", json={"nome": "Lanches"}, headers=headers)
        cat_id = resp.json()["id"]
        resp = requests.post(f"{BASE_URL}/produtos", json={
            "nome": "X-Burger", "preco": 25.0, "categoria_id": cat_id, "disponivel": True
        }, headers=headers)
        return resp.json()

    produto_a = criar_produto(headers_a)

    print("\n1. GET /kds/pendentes - pedido novo aparece")
    resp = requests.post(f"{BASE_URL}/pedidos", json={
        "itens": [{"produto_id": produto_a["id"], "nome": produto_a["nome"], "preco": produto_a["preco"], "quantidade": 1, "observacao": "sem cebola"}],
        "tipo": "balcao", "pagamento": "pix"
    }, headers=headers_a)
    if resp.status_code == 201:
        pedido = resp.json()
        log_pass("POST /pedidos - cria pedido de teste")
    else:
        log_fail("POST /pedidos", resp.text, critical=True)
        pedido = None

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    if resp.status_code == 200:
        itens = resp.json()["itens"]
        achou = any(i["origem"] == "pedido" and i["id"] == pedido["id"] and i["itens"][0]["observacao"] == "sem cebola" for i in itens)
        if achou:
            log_pass("GET /kds/pendentes - pedido novo aparece com observacao")
        else:
            log_fail("GET /kds/pendentes - pedido novo", f"nao encontrado em {itens}", critical=True)
    else:
        log_fail("GET /kds/pendentes", resp.text, critical=True)

    print("\n2. POST /kds/concluir (pedido) - remove da lista")
    resp = requests.post(f"{BASE_URL}/kds/concluir", json={"origem": "pedido", "id": pedido["id"]}, headers=headers_a)
    if resp.status_code == 200:
        log_pass("POST /kds/concluir - conclui pedido")
    else:
        log_fail("POST /kds/concluir (pedido)", resp.text, critical=True)

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if not any(i["id"] == pedido["id"] for i in itens):
        log_pass("GET /kds/pendentes - pedido concluido some da lista")
    else:
        log_fail("GET /kds/pendentes - pedido concluido", "ainda aparece na lista", critical=True)

    print("\n3. Isolamento multi-tenant")
    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_b)
    itens_b = resp.json()["itens"]
    if not any(i.get("id") == pedido["id"] for i in itens_b):
        log_pass("GET /kds/pendentes - tenant B nunca ve pedido do tenant A")
    else:
        log_fail("Isolamento multi-tenant", "tenant B viu pedido de A", critical=True)

    print("\n4. Item de comanda (mesa)")
    # O seed de registro ja abre uma comanda demo numa mesa (HANDOFF.md §10
    # armadilha 10) - precisa filtrar por status 'livre', nao pegar mesas[0].
    mesas_a = requests.get(f"{BASE_URL}/mesas", headers=headers_a).json()
    mesa_livre = next(m for m in mesas_a if m["status"] == "livre")
    resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", json={"pessoas": 2}, headers=headers_a)
    comanda = resp.json()
    resp = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", json={"produto_id": produto_a["id"], "quantidade": 1}, headers=headers_a)
    item = resp.json()["itens"][-1]

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if any(i["origem"] == "mesa" and i["id"] == item["id"] for i in itens):
        log_pass("GET /kds/pendentes - item de comanda aparece")
    else:
        log_fail("GET /kds/pendentes - item de comanda", f"nao encontrado em {itens}", critical=True)

    resp = requests.post(f"{BASE_URL}/kds/concluir", json={"origem": "mesa", "id": item["id"], "comanda_id": comanda["id"]}, headers=headers_a)
    if resp.status_code == 200:
        log_pass("POST /kds/concluir - conclui item de mesa")
    else:
        log_fail("POST /kds/concluir (mesa)", resp.text, critical=True)

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if not any(i.get("id") == item["id"] for i in itens):
        log_pass("GET /kds/pendentes - item de mesa concluido some da lista")
    else:
        log_fail("GET /kds/pendentes - item de mesa concluido", "ainda aparece", critical=True)

    print("\n5. Sem autenticacao")
    resp = requests.get(f"{BASE_URL}/kds/pendentes")
    if resp.status_code == 401:
        log_pass("GET /kds/pendentes sem token/tv_token - 401")
    else:
        log_fail("GET /kds/pendentes sem auth", f"esperava 401, veio {resp.status_code}", critical=True)

except Exception as e:
    print(f"\nFATAL ERROR: {str(e)}")
    import traceback
    traceback.print_exc()

print(f"\nPASSED: {len(results['passed'])}  FAILED: {len(results['failed'])}  CRITICAL: {len(results['critical_failures'])}")
if results['failed']:
    for f in results['failed']:
        print(f"  - {f['test']}: {f['reason']}")
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
docker start ros-mongo-local
yarn dev:no-reload
```

Em outro terminal:
```bash
PYTHONIOENCODING=utf-8 python backend_test_kds.py
```

Esperado: `CRITICAL: 0`. Investigar e corrigir qualquer falha antes de
prosseguir (regra de autocorreção do `CLAUDE.md` §2 Fase 5).

- [ ] **Step 5: Repetir contra o backend Supabase**

```bash
DATABASE_PROVIDER=supabase BASE_URL=http://localhost:3000/api PYTHONIOENCODING=utf-8 python backend_test_kds.py
```

(reiniciar o `yarn dev:no-reload` com `DATABASE_PROVIDER=supabase` antes).
Confirma paridade entre os dois backends, prática já estabelecida no
projeto (`HANDOFF.md` §7.1).

- [ ] **Step 6: Commit**

```bash
git add app/api/\[\[...path\]\]/route.js backend_test_kds.py
git commit -m "feat(kds): endpoints GET /kds/pendentes e POST /kds/concluir"
```

---

### Task 6: Endpoints de gestão do token da TV

**Files:**
- Modify: `app/api/[[...path]]/route.js` (3 rotas novas, na seção
  autenticada — sugestão: logo após o bloco `/* ==================== EMPRESA
  ==================== */`, se existir um comentário assim; caso contrário,
  em qualquer ponto após a linha `const tenant = { empresa_id: ctx.empresa_id
  }`)
- Modify: `backend_test_kds.py` (extensão)

**Interfaces:**
- Consumes: `kdsTokenRepo` (Task 3), `can()`, `audit()`, `clean()`, `uuidv4` (já importado).
- Produces: `GET /kds/tokens`, `POST /kds/tokens`, `DELETE
  /kds/tokens/:id` — consumidos pela tela de configuração na Task 9.

- [ ] **Step 1: Escrever as três rotas**

Inserir na seção autenticada (depois da linha `const tenant = { empresa_id:
ctx.empresa_id }`):

```javascript
    /* ==================== KDS TOKENS (gestao dos links da TV) ==================== */
    if (route === '/kds/tokens' && method === 'GET') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const tokens = await kdsTokenRepo.listByEmpresa(ctx.empresa_id)
      return json(tokens.map(clean))
    }
    if (route === '/kds/tokens' && method === 'POST') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      const b = (await request.json()) || {}
      const modo = b.modo === 'toque' ? 'toque' : 'leitura'
      const entity = { id: uuidv4(), empresa_id: ctx.empresa_id, token: uuidv4(), modo, criado_em: new Date(), revogado_em: null }
      await kdsTokenRepo.create(entity)
      await audit(repos, ctx, 'criar', 'kds_token', entity.id, { modo })
      return json(clean(entity), 201)
    }
    if (seg[0] === 'kds' && seg[1] === 'tokens' && seg[2] && method === 'DELETE') {
      if (!can(ctx.papel, 'empresa')) return err('Sem permissao', 403)
      await kdsTokenRepo.revoke(ctx.empresa_id, seg[2])
      await audit(repos, ctx, 'revogar', 'kds_token', seg[2], {})
      return json({ ok: true })
    }
```

- [ ] **Step 2: Estender `backend_test_kds.py`**

Adicionar antes do bloco `except Exception as e:` final:

```python
    print("\n6. Gestao de tokens da TV")
    resp = requests.post(f"{BASE_URL}/kds/tokens", json={"modo": "toque"}, headers=headers_a)
    if resp.status_code == 201 and resp.json()["modo"] == "toque":
        log_pass("POST /kds/tokens - cria token modo toque")
        tv_token = resp.json()["token"]
        tv_token_id = resp.json()["id"]
    else:
        log_fail("POST /kds/tokens", resp.text, critical=True)
        tv_token = None

    resp = requests.get(f"{BASE_URL}/kds/pendentes?tv_token={tv_token}")
    if resp.status_code == 200 and resp.json()["modo"] == "toque":
        log_pass("GET /kds/pendentes?tv_token=... - le sem login, modo correto")
    else:
        log_fail("GET /kds/pendentes com tv_token", resp.text, critical=True)

    # Token modo leitura nao pode concluir
    resp = requests.post(f"{BASE_URL}/kds/tokens", json={"modo": "leitura"}, headers=headers_a)
    tv_token_leitura = resp.json()["token"]
    # O seed de registro ja abre 1 mesa demo - pega outra que ainda esteja livre.
    mesas_a2 = requests.get(f"{BASE_URL}/mesas", headers=headers_a).json()
    mesa_livre2 = next(m for m in mesas_a2 if m["status"] == "livre")
    resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre2['id']}/abrir", json={"pessoas": 1}, headers=headers_a)
    comanda2 = resp.json()
    resp = requests.post(f"{BASE_URL}/comandas/{comanda2['id']}/itens", json={"produto_id": produto_a["id"], "quantidade": 1}, headers=headers_a)
    item2 = resp.json()["itens"][-1]

    resp = requests.post(f"{BASE_URL}/kds/concluir?tv_token={tv_token_leitura}", json={"origem": "mesa", "id": item2["id"], "comanda_id": comanda2["id"]})
    if resp.status_code == 403:
        log_pass("POST /kds/concluir com token modo leitura - 403")
    else:
        log_fail("POST /kds/concluir com token modo leitura", f"esperava 403, veio {resp.status_code}", critical=True)

    resp = requests.post(f"{BASE_URL}/kds/concluir?tv_token={tv_token}", json={"origem": "mesa", "id": item2["id"], "comanda_id": comanda2["id"]})
    if resp.status_code == 200:
        log_pass("POST /kds/concluir com token modo toque - 200")
    else:
        log_fail("POST /kds/concluir com token modo toque", resp.text, critical=True)

    # Revogar e confirmar que para de funcionar
    resp = requests.delete(f"{BASE_URL}/kds/tokens/{tv_token_id}", headers=headers_a)
    resp = requests.get(f"{BASE_URL}/kds/pendentes?tv_token={tv_token}")
    if resp.status_code == 401:
        log_pass("Token revogado - GET /kds/pendentes retorna 401")
    else:
        log_fail("Token revogado ainda funciona", f"status {resp.status_code}", critical=True)
```

- [ ] **Step 3: Rodar e confirmar**

```bash
PYTHONIOENCODING=utf-8 python backend_test_kds.py
```

Esperado: `CRITICAL: 0`.

- [ ] **Step 4: Commit**

```bash
git add app/api/\[\[...path\]\]/route.js backend_test_kds.py
git commit -m "feat(kds): endpoints de gestao do token da TV (gerar/listar/revogar)"
```

---

### Task 7: Campo de observação por item na UI (pedido e comanda)

**Files:**
- Modify: `app/page.js:641-757` (`PedidoDialog`)
- Modify: `app/page.js` (tela de comanda, função `addItem` perto da linha 1355)

**Interfaces:**
- Consumes: nenhuma nova (usa os campos `observacao` que já existem de
  ponta a ponta no backend, mapeados em `docs/plans/KDS-DESIGN.md` §3).

- [ ] **Step 1: `PedidoDialog` — input de observação + chave de agrupamento correta**

Em `app/page.js`, dentro de `PedidoDialog` (linha 641), a função `add()`
(linha 657) funde itens repetidos pelo `produto_id`. Trocar para agrupar
por `produto_id + observacao`, e adicionar um campo de observação por linha
de item:

```javascript
const add = (p, observacao = '') => setItens((s) => {
  const ex = s.find((i) => i.produto_id === p.id && (i.observacao || '') === observacao)
  if (ex) return s.map((i) => i === ex ? { ...i, quantidade: i.quantidade + 1 } : i)
  return [...s, { produto_id: p.id, nome: p.nome, preco: p.preco, quantidade: 1, observacao }]
})
```

Na lista de itens já adicionados (linha 717-723), adicionar um input de
observação por linha:

```jsx
{itens.map((i, idx) => (
  <div key={`${i.produto_id}-${i.observacao || ''}`} className="space-y-1 text-sm border-b pb-2 last:border-0">
    <div className="flex items-center justify-between">
      <span className="flex-1">{i.nome}</span>
      <div className="flex items-center gap-2"><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => dec(i.produto_id)}><Minus className="h-3 w-3" /></Button><span className="w-5 text-center">{i.quantidade}</span><Button size="icon" variant="outline" className="h-6 w-6" onClick={() => add({ id: i.produto_id, nome: i.nome, preco: i.preco }, i.observacao)}><Plus className="h-3 w-3" /></Button></div>
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
```

Nota: `dec(i.produto_id)` (linha 658) hoje remove por `produto_id` só —
como pode haver duas linhas do mesmo produto com observações diferentes,
ajustar `dec` para também considerar a observação:

```javascript
const dec = (id, observacao = '') => setItens((s) => s
  .map((i) => (i.produto_id === id && (i.observacao || '') === observacao) ? { ...i, quantidade: Math.max(0, i.quantidade - 1) } : i)
  .filter((i) => i.quantidade > 0))
```

E o botão de decremento na lista passa a chamar `dec(i.produto_id,
i.observacao)`.

- [ ] **Step 2: Tela de comanda — input de observação ao lançar item**

Perto da linha 1355 (`addItem`), a chamada hoje só manda
`{produto_id, quantidade}`. Trocar o botão de produto por um pequeno fluxo
com observação opcional — mais simples: adicionar `useState` para o texto
digitado antes de confirmar, ou (mais direto, sem novo estado de UI)
adicionar um prompt inline. Seguindo o padrão do resto do arquivo (sem
`window.prompt`, sempre inputs na própria tela), adicionar um campo de
observação junto da lista de produtos:

```javascript
const [obsPendente, setObsPendente] = useState('')
const addItem = async (p) => {
  try {
    const d = await api(`/comandas/${comandaId}/itens`, { method: 'POST', body: { produto_id: p.id, quantidade: 1, observacao: obsPendente } })
    setC(d)
    setObsPendente('')
  } catch (e) { toast.error(e.message) }
}
```

E no bloco `addOpen` (linha 1374-1378), adicionar o input antes da lista de
produtos:

```jsx
{addOpen && (
  <div className="space-y-2">
    <Input placeholder="Observacao (opcional) — ex: sem cebola" className="h-8 text-xs" value={obsPendente} onChange={(e) => setObsPendente(e.target.value)} />
    <div className="border rounded-lg divide-y max-h-40 overflow-auto ros-scroll">
      {prods.map((p) => <button key={p.id} onClick={() => addItem(p)} className="w-full flex items-center justify-between p-2.5 hover:bg-accent text-left text-sm"><span>{p.nome}</span><span className="text-muted-foreground">{brl(p.preco)}</span></button>)}
    </div>
  </div>
)}
```

- [ ] **Step 3: Verificar manualmente no navegador**

```bash
docker start ros-mongo-local
yarn dev:no-reload
```

Abrir `localhost:3000`, logar, criar um pedido de balcão com 2 unidades do
mesmo produto, uma com observação "sem cebola" e outra sem — confirmar que
viram duas linhas separadas (não uma linha quantidade 2). Repetir em Mesas
-> abrir comanda -> adicionar item com observação, confirmar que aparece
listado (`i.observacao && ...`, já existente na linha 1383).

- [ ] **Step 4: Commit**

```bash
git add app/page.js
git commit -m "feat(pedidos,comanda): campo de observacao por item na tela"
```

---

### Task 8: Componentes de KDS (`components/kds.jsx`)

**Files:**
- Create: `components/kds.jsx`

**Interfaces:**
- Consumes: `GET /kds/pendentes` e `POST /kds/concluir` (Task 5), direto
  via `fetch` (não usa o helper `api()` de `app/page.js` porque a TV não
  tem token de usuário).
- Produces: `export function KDSTv({ token })`, `export function
  KDSView()` (autenticado por Bearer, sem toque), `export function
  CozinhaPendentes()` (autenticado por Bearer, sempre com toque — tela do
  celular do atendente). Consumidos por `app/page.js` na Task 9.

- [ ] **Step 1: Escrever o componente compartilhado de lista + card**

```jsx
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
```

- [ ] **Step 2: Verificar que o arquivo não quebra o build**

```bash
yarn build
```

Esperado: build passa (o componente ainda não é importado em lugar nenhum
nesta task, mas precisa ser JSX/JS válido). Depois do build, se o dev
server estava rodando, seguir a armadilha 15 do `HANDOFF.md` (`rm -rf
.next` se `yarn dev:no-reload` tiver sido corrompido).

- [ ] **Step 3: Commit**

```bash
git add components/kds.jsx
git commit -m "feat(kds): componentes de painel (TV, cozinha logada, celular do atendente)"
```

---

### Task 9: Ligar o KDS no `App()` — TV, papel COZINHA, e nav do celular

**Files:**
- Modify: `app/page.js:1631-1770` (`App()`)
- Modify: `app/page.js:1617-1629` (`NAV`)

**Interfaces:**
- Consumes: `KDSTv`, `KDSView`, `CozinhaPendentes` (Task 8); `api()` (já
  existente).

- [ ] **Step 1: Import**

No topo de `app/page.js`, junto dos outros imports de `@/components/...`
(linha 33):

```javascript
import { KDSTv, KDSView, CozinhaPendentes } from '@/components/kds'
```

- [ ] **Step 2: Rota da TV — antes de qualquer chamada de `loadMe()`**

Dentro de `App()` (linha 1631), logo após a declaração dos `useState`
(antes do `useEffect(() => { loadMe() }, [loadMe])`, linha 1679), ler o
query param direto do browser (sem `useSearchParams` do Next — evita
exigência de `<Suspense>` do App Router; este componente já é `'use
client'` e a leitura é só no primeiro render):

```javascript
const kdsTvToken = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('kds_tv') : null
```

E, logo no topo do `return` do componente (antes do `if (me === undefined)
...`, linha 1690), interceptar:

```javascript
if (kdsTvToken) return <KDSTv token={kdsTvToken} />
```

- [ ] **Step 3: Papel COZINHA — landing exclusivo**

Depois de `if (me === null) return <><AuthScreen ... /></>` (linha 1691),
adicionar:

```javascript
if (me.usuario?.papel === 'COZINHA') return <KDSView apiFetch={api} />
```

- [ ] **Step 4: Item de navegação para o celular do atendente**

Em `NAV` (linha 1617-1629), adicionar:

```javascript
{ key: 'kds_concluir', label: 'Cozinha', icon: ChefHat, perm: 'pedidos' },
```

E no `<main>` (linha 1751-1763), adicionar:

```javascript
{view === 'kds_concluir' && <CozinhaPendentes apiFetch={api} />}
```

- [ ] **Step 5: Verificar manualmente os três caminhos**

```bash
docker start ros-mongo-local
yarn dev:no-reload
```

1. **TV:** gerar um token via `POST /api/kds/tokens` (curl, com um usuário
   ADMIN/OWNER logado — endpoint só existe depois da Task 10 ter UI, mas a
   API já funciona desde a Task 6) e abrir
   `localhost:3000/?kds_tv=<token>` numa aba anônima (sem login). Esperado:
   painel cheio, sem sidebar, sem pedir login.
2. **COZINHA:** criar um usuário com papel `COZINHA` (`POST /usuarios`,
   como ADMIN), logar com ele. Esperado: cai direto no painel, sem sidebar,
   sem toque nos cards.
3. **Celular do atendente:** logar como ATENDENTE, abrir o menu "Cozinha".
   Esperado: mesma lista, com toque — tocar um card remove ele da lista.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "feat(kds): liga TV, papel COZINHA e menu do atendente no App()"
```

---

### Task 10: Tela de configuração — gerar/listar/revogar link da TV

**Files:**
- Modify: `app/page.js:1021-1220` (componente `Empresa`, aproximadamente —
  localizar pelo `TabsList`/`TabsContent` de `modulos`, linha 1156-1160)

**Interfaces:**
- Consumes: `GET /kds/tokens`, `POST /kds/tokens`, `DELETE
  /kds/tokens/:id` (Task 6), via `api()`.

- [ ] **Step 1: Nova aba na `TabsList`**

Linha 1078, trocar:

```jsx
<TabsList><TabsTrigger value="dados">Empresa</TabsTrigger><TabsTrigger value="aparencia">Aparencia</TabsTrigger><TabsTrigger value="pagamentos">Pagamentos</TabsTrigger><TabsTrigger value="modulos">Modulos</TabsTrigger></TabsList>
```

por:

```jsx
<TabsList><TabsTrigger value="dados">Empresa</TabsTrigger><TabsTrigger value="aparencia">Aparencia</TabsTrigger><TabsTrigger value="pagamentos">Pagamentos</TabsTrigger><TabsTrigger value="modulos">Modulos</TabsTrigger><TabsTrigger value="kds">Cozinha (KDS)</TabsTrigger></TabsList>
```

- [ ] **Step 2: Estado e ações de token, dentro de `Empresa`**

Perto do topo do componente `Empresa` (linha 1021-1023), adicionar:

```javascript
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
```

- [ ] **Step 3: Conteúdo da aba**

Após o `TabsContent value="modulos"` (fechamento perto da linha 1160+),
adicionar:

```jsx
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
```

- [ ] **Step 4: Verificar manualmente**

Logar como OWNER/ADMIN, ir em Empresa -> aba "Cozinha (KDS)", gerar um link
de cada modo, copiar, abrir numa aba anônima e confirmar que carrega o
painel. Revogar um e confirmar que a aba anônima passa a mostrar erro (após
o próximo polling de 5s).

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat(kds): tela de configuracao para gerar/revogar link da TV"
```

---

### Task 11: Validação final (Definition of Done)

**Files:** nenhum novo — task de verificação.

- [ ] **Step 1: Suite completa de regressão**

```bash
docker start ros-mongo-local
yarn dev:no-reload
```

```bash
PYTHONIOENCODING=utf-8 python backend_test.py
PYTHONIOENCODING=utf-8 python backend_test_v2.py 2>/dev/null || true
PYTHONIOENCODING=utf-8 python backend_test_v3.py
PYTHONIOENCODING=utf-8 python backend_test_kds.py
```

Comparar contra o baseline do `HANDOFF.md` §7.1 (v1: 40/40, v2: 39/39, v3:
32/33 com a falha conhecida). Nenhuma regressão nova é aceitável.

- [ ] **Step 2: Repetir contra Supabase**

```bash
DATABASE_PROVIDER=supabase yarn dev:no-reload
```
```bash
PYTHONIOENCODING=utf-8 python backend_test.py
PYTHONIOENCODING=utf-8 python backend_test_kds.py
```

- [ ] **Step 3: Build de produção**

```bash
yarn build
```

Esperado: build passa sem erro (atenção à armadilha 15 do `HANDOFF.md`:
nunca validar env no nível do módulo — este plano não introduz nenhuma
checagem de env nova, só confirmar que nada quebrou isso).

- [ ] **Step 4: Revisão de segurança e multi-tenancy (manual, checklist)**

- [ ] `GET /kds/pendentes` e `POST /kds/concluir` nunca vazam dado de outra
  empresa (coberto por teste automatizado na Task 5/6, reconfirmar lendo o
  código: todo acesso usa `kctx.empresa_id`, nunca um id vindo do corpo da
  requisição).
- [ ] Token da TV não consegue acessar nenhuma rota fora de
  `/kds/pendentes` e `/kds/concluir` (essas duas são as únicas que chamam
  `resolveKdsAuth()` — todo o resto do sistema exige o portão de
  autenticação padrão).
- [ ] Token em modo `leitura` recebe 403 em `POST /kds/concluir` (coberto
  no teste da Task 6).
- [ ] `kds_tokens` tem RLS habilitado (Task 1) mesmo sabendo que
  `service_role` o ignora em runtime (armadilha 13 do `HANDOFF.md`) —
  defesa em profundidade.
- [ ] Geração/revogação de token exige permissão `empresa` (só
  ADMIN/OWNER).

- [ ] **Step 5: Não atualizar `HANDOFF.md` automaticamente**

Registro deliberado: a atualização do `HANDOFF.md` só acontece quando o
dono do projeto pedir um handoff (`CLAUDE.md` §18.1) — não fazer isso como
parte automática deste plano.

- [ ] **Step 6: Relatório final**

Seguir o formato do `CLAUDE.md` §18 (Implementado / Arquivos alterados /
Testes / Lint / Typecheck / Build / Validações / Observações).
