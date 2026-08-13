# Caixa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abertura e fechamento de caixa com sangria, suprimento, conferencia de valores e estorno de venda.

**Architecture:** Duas tabelas novas (`caixas`, `caixa_movimentos`) e duas colunas em `transacoes`. O calculo do valor esperado vive em modulo puro (`lib/caixa.js`), testavel sem banco e sem navegador, no mesmo padrao de `lib/cupom-dados.js`. Repositorios nos dois backends. Endpoints no `route.js`. UI na aba Financeiro.

**Tech Stack:** Supabase (Postgres) + MongoDB, Next.js App Router, React + Tailwind, testes de API em Python (`requests`).

**Spec:** `docs/superpowers/specs/2026-08-13-caixa-design.md`

## Global Constraints

- Tabela `caixas`: `status` e `'aberto'` ou `'fechado'`; indice unico parcial `(empresa_id) WHERE status = 'aberto'` garante um caixa aberto por empresa
- Tabela `caixa_movimentos`: `tipo` e `'sangria'` ou `'suprimento'`; indice em `(empresa_id, caixa_id)`
- `transacoes` ganha `forma_pagamento TEXT NOT NULL DEFAULT ''` e `caixa_id UUID NULL`
- Formula: `valor_esperado = valor_abertura + receitas_dinheiro - estornos_dinheiro + suprimentos - sangrias`
- **So dinheiro conta.** PIX e cartao nunca entram no valor esperado da gaveta
- `diferenca = valor_contado - valor_esperado`; positiva e sobra, negativa e falta
- `observacoes` e obrigatoria no fechamento quando `diferenca != 0`
- Sangria nao pode exceder o dinheiro disponivel no momento
- Comanda com N pagamentos gera N transacoes, uma por metodo; sem pagamento registrado, gera uma com `forma_pagamento = 'dinheiro'`
- Estorno e `transacao` tipo `'despesa'`, categoria `'Estorno'`, com `pedido_id` do pedido original; o `total` do pedido nunca muda
- Venda sem caixa aberto e permitida e grava `caixa_id` nulo
- Todo endpoint de caixa e de estorno exige papel GERENTE ou acima e grava em `auditoria`
- Nenhuma migracao retroativa: transacoes antigas ficam com `forma_pagamento = ''`

---

### Task 1: Schema e contratos de dominio

**Files:**
- Create: `supabase/migrations/0018_caixa.sql`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: tipos `CaixaStatus`, `CaixaMovimentoTipo`; interfaces `Caixa`, `CaixaMovimento`, `CaixaRepository`, `CaixaMovimentoRepository`; `Transacao` com `forma_pagamento: string` e `caixa_id: UUID | null`

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/0018_caixa.sql`. A ordem importa: `caixas` precisa existir antes da FK em `transacoes`.

```sql
-- 0018_caixa.sql
-- Caixa: abertura/fechamento, sangria/suprimento, forma de pagamento na transacao.

CREATE TABLE caixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'aberto',
  aberto_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  aberto_por_nome TEXT NOT NULL DEFAULT '',
  aberto_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valor_abertura NUMERIC(10,2) NOT NULL DEFAULT 0,
  fechado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  fechado_por_nome TEXT NOT NULL DEFAULT '',
  fechado_em TIMESTAMPTZ,
  valor_contado NUMERIC(10,2),
  valor_esperado NUMERIC(10,2),
  diferenca NUMERIC(10,2),
  observacoes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT caixas_status_valido CHECK (status IN ('aberto', 'fechado'))
);

-- Um unico caixa aberto por empresa. O indice parcial e a garantia real:
-- a checagem na aplicacao evita a mensagem feia, este indice evita a corrida.
CREATE UNIQUE INDEX caixas_um_aberto_por_empresa
  ON caixas (empresa_id) WHERE status = 'aberto';

CREATE INDEX caixas_empresa_status ON caixas (empresa_id, status);

ALTER TABLE caixas ENABLE ROW LEVEL SECURITY;
CREATE POLICY caixas_por_empresa ON caixas
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

CREATE TABLE caixa_movimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  caixa_id UUID NOT NULL REFERENCES caixas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  valor NUMERIC(10,2) NOT NULL,
  motivo TEXT NOT NULL DEFAULT '',
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT caixa_movimentos_tipo_valido CHECK (tipo IN ('sangria', 'suprimento')),
  CONSTRAINT caixa_movimentos_valor_positivo CHECK (valor > 0)
);

CREATE INDEX caixa_movimentos_empresa_caixa
  ON caixa_movimentos (empresa_id, caixa_id);

ALTER TABLE caixa_movimentos ENABLE ROW LEVEL SECURITY;
CREATE POLICY caixa_movimentos_por_empresa ON caixa_movimentos
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM usuarios WHERE id = auth.uid()));

ALTER TABLE transacoes
  ADD COLUMN forma_pagamento TEXT NOT NULL DEFAULT '',
  ADD COLUMN caixa_id UUID REFERENCES caixas(id) ON DELETE SET NULL;

CREATE INDEX transacoes_empresa_caixa ON transacoes (empresa_id, caixa_id);
```

- [ ] **Step 2: Atualizar os contratos de dominio**

Em `packages/domain/src/index.ts`, junto aos outros type aliases do topo do arquivo:

```typescript
export type CaixaStatus = 'aberto' | 'fechado';
export type CaixaMovimentoTipo = 'sangria' | 'suprimento';
```

Substituir a interface `Transacao` inteira por:

```typescript
export interface Transacao extends TenantScoped {
  id: UUID; tipo: TransacaoTipo; categoria: string; descricao: string;
  valor: number; pedido_id: UUID | null; comanda_id: UUID | null; data: string;
  /**
   * Metodo desta transacao ('pix' | 'cartao' | 'dinheiro'). Transacoes
   * anteriores a migration 0018 tem string vazia — nao ha dado de onde
   * inferir o metodo, e inventar um falsearia a auditoria.
   */
  forma_pagamento: string;
  /** Caixa em que a venda entrou. Nulo quando nao havia caixa aberto. */
  caixa_id: UUID | null;
}
```

Adicionar as interfaces novas depois de `Transacao`:

```typescript
/**
 * Sessao de caixa. Um caixa aberto por empresa por vez — garantido por
 * indice unico parcial no Postgres, nao so pela checagem na aplicacao.
 */
export interface Caixa extends TenantScoped {
  id: UUID;
  status: CaixaStatus;
  aberto_por: UUID | null;
  aberto_por_nome: string;
  aberto_em: string;
  /** Fundo de troco colocado na gaveta na abertura. */
  valor_abertura: number;
  fechado_por: UUID | null;
  fechado_por_nome: string;
  fechado_em: string | null;
  /** O que foi contado fisicamente na gaveta. Nulo enquanto aberto. */
  valor_contado: number | null;
  /** O que o Service calculou. Nulo enquanto aberto. */
  valor_esperado: number | null;
  /** `valor_contado - valor_esperado`. Positivo e sobra, negativo e falta. */
  diferenca: number | null;
  observacoes: string;
  created_at: string;
}

/**
 * Movimento de gaveta que NAO e venda. Sangria leva dinheiro ao cofre,
 * suprimento traz troco. Nenhum dos dois e receita ou despesa — por isso
 * vivem aqui e nunca em `transacoes`.
 */
export interface CaixaMovimento extends TenantScoped {
  id: UUID;
  caixa_id: UUID;
  tipo: CaixaMovimentoTipo;
  valor: number;
  motivo: string;
  usuario_id: UUID | null;
  usuario_nome: string;
  created_at: string;
}

export interface CaixaRepository extends Repository<Caixa> {
  findAberto(empresaId: UUID): Promise<Caixa | null>;
  listarFechados(empresaId: UUID, limite?: number): Promise<Caixa[]>;
}

export interface CaixaMovimentoRepository extends Repository<CaixaMovimento> {
  listByCaixa(empresaId: UUID, caixaId: UUID): Promise<CaixaMovimento[]>;
}
```

Adicionar ao `TransacaoRepository` existente os dois metodos novos:

```typescript
  findByCaixa(empresaId: UUID, caixaId: UUID): Promise<Transacao[]>;
  findByPedido(empresaId: UUID, pedidoId: UUID): Promise<Transacao[]>;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0018_caixa.sql packages/domain/src/index.ts
git commit -m "schema: tabelas caixas e caixa_movimentos, forma_pagamento em transacoes"
```

---

### Task 2: Modulo de calculo puro

**Files:**
- Create: `lib/caixa.js`
- Create: `test_caixa_calculo.mjs`

**Interfaces:**
- Produces: `computeCaixaEsperado({ valor_abertura, transacoes, movimentos })` retornando `{ valor_abertura, receitas_dinheiro, estornos_dinheiro, suprimentos, sangrias, valor_esperado, por_forma_pagamento }`

Este modulo existe para que a formula viva em **um lugar so**. O fechamento e a
validacao de sangria precisam do mesmo numero; sem isso, a logica seria copiada
nos dois endpoints e as duas copias divergiriam.

- [ ] **Step 1: Escrever o teste que falha**

Criar `test_caixa_calculo.mjs` na raiz do projeto:

```javascript
import assert from 'node:assert/strict'
import { computeCaixaEsperado } from './lib/caixa.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('caixa sem movimento nenhum devolve o fundo de troco', () => {
  const r = computeCaixaEsperado({ valor_abertura: 100, transacoes: [], movimentos: [] })
  assert.equal(r.valor_esperado, 100)
})

teste('venda em dinheiro entra no esperado', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 50 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 150)
  assert.equal(r.receitas_dinheiro, 50)
})

teste('venda em pix e cartao NAO entra no esperado da gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'pix', valor: 80 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'cartao', valor: 70 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
  assert.equal(r.receitas_dinheiro, 0)
})

teste('sangria reduz e suprimento aumenta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [],
    movimentos: [
      { tipo: 'sangria', valor: 30 },
      { tipo: 'suprimento', valor: 20 },
    ],
  })
  assert.equal(r.valor_esperado, 90)
  assert.equal(r.sangrias, 30)
  assert.equal(r.suprimentos, 20)
})

teste('estorno em dinheiro reduz o esperado', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 50 },
      { tipo: 'despesa', categoria: 'Estorno', forma_pagamento: 'dinheiro', valor: 20 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 130)
  assert.equal(r.estornos_dinheiro, 20)
})

teste('estorno em pix NAO reduz o esperado da gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'despesa', categoria: 'Estorno', forma_pagamento: 'pix', valor: 20 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('despesa comum nao mexe na gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'despesa', categoria: 'Fornecedor', forma_pagamento: 'dinheiro', valor: 40 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('resumo por forma de pagamento soma todas as receitas', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 0,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 10 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 15 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'pix', valor: 40 },
    ],
    movimentos: [],
  })
  assert.equal(r.por_forma_pagamento.dinheiro, 25)
  assert.equal(r.por_forma_pagamento.pix, 40)
})

teste('transacao antiga sem forma_pagamento nao entra na gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'receita', categoria: 'Vendas', forma_pagamento: '', valor: 99 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('centavos nao acumulam erro de ponto flutuante', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 0,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 0.1 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 0.2 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 0.3)
})

console.log(`\n${passou} testes passaram`)
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node test_caixa_calculo.mjs`
Expected: FAIL — `Cannot find module './lib/caixa.js'`

- [ ] **Step 3: Implementar o modulo**

Criar `lib/caixa.js`:

```javascript
/**
 * Calculo do valor esperado na gaveta do caixa.
 *
 * Modulo puro: nao toca banco, nao toca HTTP. Existe separado para que a
 * formula viva em um lugar so — o fechamento e a validacao de sangria
 * precisam exatamente do mesmo numero.
 *
 * So DINHEIRO entra na conta. PIX e cartao caem na conta bancaria e nunca
 * estao na gaveta para serem contados.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param {object} p
 * @param {number} p.valor_abertura fundo de troco
 * @param {Array<{tipo: string, categoria: string, forma_pagamento: string, valor: number}>} p.transacoes
 * @param {Array<{tipo: string, valor: number}>} p.movimentos
 */
export function computeCaixaEsperado({ valor_abertura, transacoes, movimentos }) {
  const abertura = round2(valor_abertura)
  const trans = transacoes || []
  const movs = movimentos || []

  const ehDinheiro = (t) => t.forma_pagamento === 'dinheiro'

  const receitas_dinheiro = round2(
    trans.filter((t) => t.tipo === 'receita' && ehDinheiro(t))
      .reduce((s, t) => s + Number(t.valor || 0), 0)
  )

  const estornos_dinheiro = round2(
    trans.filter((t) => t.tipo === 'despesa' && t.categoria === 'Estorno' && ehDinheiro(t))
      .reduce((s, t) => s + Number(t.valor || 0), 0)
  )

  const suprimentos = round2(
    movs.filter((m) => m.tipo === 'suprimento').reduce((s, m) => s + Number(m.valor || 0), 0)
  )

  const sangrias = round2(
    movs.filter((m) => m.tipo === 'sangria').reduce((s, m) => s + Number(m.valor || 0), 0)
  )

  // Resumo de TODAS as receitas por metodo — usado pela tela de fechamento e,
  // depois, pelo grafico de pizza dos relatorios. Inclui pix e cartao, que nao
  // entram no esperado da gaveta mas o operador precisa ver.
  const por_forma_pagamento = {}
  for (const t of trans) {
    if (t.tipo !== 'receita') continue
    const forma = t.forma_pagamento || 'nao_informado'
    por_forma_pagamento[forma] = round2((por_forma_pagamento[forma] || 0) + Number(t.valor || 0))
  }

  const valor_esperado = round2(
    abertura + receitas_dinheiro - estornos_dinheiro + suprimentos - sangrias
  )

  return {
    valor_abertura: abertura,
    receitas_dinheiro,
    estornos_dinheiro,
    suprimentos,
    sangrias,
    valor_esperado,
    por_forma_pagamento,
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node test_caixa_calculo.mjs`
Expected: `10 testes passaram`, saida limpa

- [ ] **Step 5: Commit**

```bash
git add lib/caixa.js test_caixa_calculo.mjs
git commit -m "feat: modulo puro de calculo do valor esperado do caixa"
```

---

### Task 3: Repositorios Supabase

**Files:**
- Create: `lib/repositories/supabase/caixaRepository.js`
- Create: `lib/repositories/supabase/caixaMovimentoRepository.js`

**Interfaces:**
- Produces: `createCaixaRepository(supabase)` e `createCaixaMovimentoRepository(supabase)`

Antes de escrever, abra `lib/repositories/supabase/entregadorRepository.js` e siga
exatamente a mesma forma: o helper `unwrap`, o formato de export, o tratamento de
"nao encontrado". O codigo abaixo usa `unwrap` do mesmo modulo que os outros
repositorios Supabase usam — confira o caminho do import naquele arquivo e use o
mesmo.

- [ ] **Step 1: Implementar `caixaRepository.js`**

```javascript
import { unwrap } from './_helpers.js' // confira o caminho em entregadorRepository.js

export function createCaixaRepository(supabase) {
  return {
    async create(entity) {
      const { data, error } = await supabase
        .from('caixas')
        .insert({
          id: entity.id,
          empresa_id: entity.empresa_id,
          status: entity.status || 'aberto',
          aberto_por: entity.aberto_por || null,
          aberto_por_nome: entity.aberto_por_nome || '',
          aberto_em: entity.aberto_em || new Date().toISOString(),
          valor_abertura: entity.valor_abertura || 0,
          created_at: entity.created_at || new Date().toISOString(),
        })
        .select()
        .single()
      return unwrap(data, error)
    },

    async findById(empresaId, id) {
      const { data, error } = await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .maybeSingle()
      return unwrap(data, error)
    },

    async findAberto(empresaId) {
      const { data, error } = await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('status', 'aberto')
        .maybeSingle()
      return unwrap(data, error)
    },

    async listarFechados(empresaId, limite = 20) {
      const { data, error } = await supabase
        .from('caixas')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechado')
        .order('fechado_em', { ascending: false })
        .limit(limite)
      return unwrap(data, error) || []
    },

    async update(empresaId, id, patch) {
      const { data, error } = await supabase
        .from('caixas')
        .update(patch)
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .select()
        .single()
      return unwrap(data, error)
    },
  }
}
```

- [ ] **Step 2: Implementar `caixaMovimentoRepository.js`**

```javascript
import { unwrap } from './_helpers.js' // mesmo caminho do arquivo anterior

export function createCaixaMovimentoRepository(supabase) {
  return {
    async create(entity) {
      const { data, error } = await supabase
        .from('caixa_movimentos')
        .insert({
          id: entity.id,
          empresa_id: entity.empresa_id,
          caixa_id: entity.caixa_id,
          tipo: entity.tipo,
          valor: entity.valor,
          motivo: entity.motivo || '',
          usuario_id: entity.usuario_id || null,
          usuario_nome: entity.usuario_nome || '',
          created_at: entity.created_at || new Date().toISOString(),
        })
        .select()
        .single()
      return unwrap(data, error)
    },

    async findById(empresaId, id) {
      const { data, error } = await supabase
        .from('caixa_movimentos')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('id', id)
        .maybeSingle()
      return unwrap(data, error)
    },

    async listByCaixa(empresaId, caixaId) {
      const { data, error } = await supabase
        .from('caixa_movimentos')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('caixa_id', caixaId)
        .order('created_at', { ascending: true })
      return unwrap(data, error) || []
    },
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/repositories/supabase/caixaRepository.js lib/repositories/supabase/caixaMovimentoRepository.js
git commit -m "feat: repositorios de caixa e movimento no backend Supabase"
```

---

### Task 4: Repositorios Mongo, indices e registro na factory

**Files:**
- Create: `lib/repositories/mongo/caixaRepository.js`
- Create: `lib/repositories/mongo/caixaMovimentoRepository.js`
- Modify: `lib/repositories/factory.js`

**Interfaces:**
- Consumes: nada de tasks anteriores
- Produces: `caixaRepo` e `caixaMovimentoRepo` disponiveis em `repos` nos dois backends

Antes de escrever, abra `lib/repositories/mongo/entregadorRepository.js` e siga a
mesma forma de export e de normalizacao.

- [ ] **Step 1: Implementar `mongo/caixaRepository.js`**

```javascript
function normalize(doc) {
  if (!doc) return null
  return {
    id: doc._id,
    empresa_id: doc.empresa_id,
    status: doc.status,
    aberto_por: doc.aberto_por ?? null,
    aberto_por_nome: doc.aberto_por_nome || '',
    aberto_em: doc.aberto_em ? new Date(doc.aberto_em).toISOString() : null,
    valor_abertura: doc.valor_abertura || 0,
    fechado_por: doc.fechado_por ?? null,
    fechado_por_nome: doc.fechado_por_nome || '',
    fechado_em: doc.fechado_em ? new Date(doc.fechado_em).toISOString() : null,
    valor_contado: doc.valor_contado ?? null,
    valor_esperado: doc.valor_esperado ?? null,
    diferenca: doc.diferenca ?? null,
    observacoes: doc.observacoes || '',
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : null,
  }
}

export function createCaixaRepository(db) {
  const col = db.collection('caixas')
  return {
    async create(entity) {
      await col.insertOne({
        _id: entity.id,
        empresa_id: entity.empresa_id,
        status: entity.status || 'aberto',
        aberto_por: entity.aberto_por || null,
        aberto_por_nome: entity.aberto_por_nome || '',
        aberto_em: entity.aberto_em ? new Date(entity.aberto_em) : new Date(),
        valor_abertura: entity.valor_abertura || 0,
        fechado_por: null,
        fechado_por_nome: '',
        fechado_em: null,
        valor_contado: null,
        valor_esperado: null,
        diferenca: null,
        observacoes: '',
        created_at: entity.created_at ? new Date(entity.created_at) : new Date(),
      })
      return this.findById(entity.empresa_id, entity.id)
    },

    async findById(empresaId, id) {
      return normalize(await col.findOne({ _id: id, empresa_id: empresaId }))
    },

    async findAberto(empresaId) {
      return normalize(await col.findOne({ empresa_id: empresaId, status: 'aberto' }))
    },

    async listarFechados(empresaId, limite = 20) {
      const docs = await col
        .find({ empresa_id: empresaId, status: 'fechado' })
        .sort({ fechado_em: -1 })
        .limit(limite)
        .toArray()
      return docs.map(normalize)
    },

    async update(empresaId, id, patch) {
      const set = { ...patch }
      // Datas chegam como ISO string do Service; o Mongo guarda Date.
      for (const campo of ['fechado_em', 'aberto_em']) {
        if (set[campo]) set[campo] = new Date(set[campo])
      }
      await col.updateOne({ _id: id, empresa_id: empresaId }, { $set: set })
      return this.findById(empresaId, id)
    },
  }
}
```

- [ ] **Step 2: Implementar `mongo/caixaMovimentoRepository.js`**

```javascript
function normalize(doc) {
  if (!doc) return null
  return {
    id: doc._id,
    empresa_id: doc.empresa_id,
    caixa_id: doc.caixa_id,
    tipo: doc.tipo,
    valor: doc.valor,
    motivo: doc.motivo || '',
    usuario_id: doc.usuario_id ?? null,
    usuario_nome: doc.usuario_nome || '',
    created_at: doc.created_at ? new Date(doc.created_at).toISOString() : null,
  }
}

export function createCaixaMovimentoRepository(db) {
  const col = db.collection('caixa_movimentos')
  return {
    async create(entity) {
      await col.insertOne({
        _id: entity.id,
        empresa_id: entity.empresa_id,
        caixa_id: entity.caixa_id,
        tipo: entity.tipo,
        valor: entity.valor,
        motivo: entity.motivo || '',
        usuario_id: entity.usuario_id || null,
        usuario_nome: entity.usuario_nome || '',
        created_at: entity.created_at ? new Date(entity.created_at) : new Date(),
      })
      return this.findById(entity.empresa_id, entity.id)
    },

    async findById(empresaId, id) {
      return normalize(await col.findOne({ _id: id, empresa_id: empresaId }))
    },

    async listByCaixa(empresaId, caixaId) {
      const docs = await col
        .find({ empresa_id: empresaId, caixa_id: caixaId })
        .sort({ created_at: 1 })
        .toArray()
      return docs.map(normalize)
    },
  }
}
```

- [ ] **Step 3: Registrar na factory e criar os indices**

Em `lib/repositories/factory.js`, seguindo exatamente o padrao ja usado por
`entregadorRepo` (import no topo, chamada no builder):

```javascript
// imports no topo, junto dos outros
import { createCaixaRepository as mongoCaixa } from './mongo/caixaRepository'
import { createCaixaMovimentoRepository as mongoCaixaMovimento } from './mongo/caixaMovimentoRepository'
import { createCaixaRepository as sbCaixa } from './supabase/caixaRepository'
import { createCaixaMovimentoRepository as sbCaixaMovimento } from './supabase/caixaMovimentoRepository'

// dentro de buildMongoRepositories(database), no objeto retornado:
caixaRepo: mongoCaixa(database),
caixaMovimentoRepo: mongoCaixaMovimento(database),

// dentro de buildSupabaseRepositories(supabase), no objeto retornado:
caixaRepo: sbCaixa(supabase),
caixaMovimentoRepo: sbCaixaMovimento(supabase),
```

Em `ensureMongoIndexes(db)`, junto dos outros indices:

```javascript
await db.collection('caixas').createIndex({ empresa_id: 1, status: 1 })
// Equivalente Mongo do indice unico parcial do Postgres: garante um unico
// caixa aberto por empresa mesmo sob duas requisicoes simultaneas.
await db.collection('caixas').createIndex(
  { empresa_id: 1 },
  { unique: true, partialFilterExpression: { status: 'aberto' } }
)
await db.collection('caixa_movimentos').createIndex({ empresa_id: 1, caixa_id: 1 })
```

- [ ] **Step 4: Commit**

```bash
git add lib/repositories/mongo/caixaRepository.js lib/repositories/mongo/caixaMovimentoRepository.js lib/repositories/factory.js
git commit -m "feat: repositorios de caixa no Mongo, indices e registro na factory"
```

---

### Task 5: Consultas de transacao por caixa e por pedido

**Files:**
- Modify: `lib/repositories/mongo/transacaoRepository.js`
- Modify: `lib/repositories/supabase/transacaoRepository.js`

**Interfaces:**
- Produces: `transacaoRepo.findByCaixa(empresaId, caixaId)` e `transacaoRepo.findByPedido(empresaId, pedidoId)`, ambos devolvendo `Transacao[]`

`findByCaixa` alimenta o calculo do esperado. `findByPedido` alimenta a validacao
de estorno acumulado.

- [ ] **Step 1: Adicionar os metodos no repositorio Mongo**

Dentro do objeto retornado por `createTransacaoRepository(db)`:

```javascript
    async findByCaixa(empresaId, caixaId) {
      const docs = await col.find({ empresa_id: empresaId, caixa_id: caixaId }).toArray()
      return docs.map(normalize)
    },

    async findByPedido(empresaId, pedidoId) {
      const docs = await col.find({ empresa_id: empresaId, pedido_id: pedidoId }).toArray()
      return docs.map(normalize)
    },
```

Use o mesmo `normalize` que os outros metodos deste arquivo ja usam. Se o
`normalize` existente nao devolve `forma_pagamento` e `caixa_id`, adicione os dois
campos nele — sem isso o calculo do esperado recebe `undefined` e o caixa fecha
sempre com o valor da abertura.

- [ ] **Step 2: Adicionar os metodos no repositorio Supabase**

Dentro do objeto retornado por `createTransacaoRepository(supabase)`:

```javascript
    async findByCaixa(empresaId, caixaId) {
      const { data, error } = await supabase
        .from('transacoes')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('caixa_id', caixaId)
      return unwrap(data, error) || []
    },

    async findByPedido(empresaId, pedidoId) {
      const { data, error } = await supabase
        .from('transacoes')
        .select('*')
        .eq('empresa_id', empresaId)
        .eq('pedido_id', pedidoId)
      return unwrap(data, error) || []
    },
```

- [ ] **Step 3: Commit**

```bash
git add lib/repositories/mongo/transacaoRepository.js lib/repositories/supabase/transacaoRepository.js
git commit -m "feat: consultas de transacao por caixa e por pedido nos dois backends"
```

---

### Task 6: Forma de pagamento na origem

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `repos.caixaRepo.findAberto(empresaId)`
- Produces: toda transacao de receita nasce com `forma_pagamento` e `caixa_id` preenchidos

Esta e a correcao que o spec chama de pre-requisito: hoje uma comanda paga com
dois metodos grava so o primeiro (`route.js:1635`) e o resto se perde.

- [ ] **Step 1: Uma transacao por pagamento no fechamento de comanda**

Localize o trecho que fecha comanda (procure por `descricao: \`Comanda ${comanda.mesa_nome}`).
Substitua a criacao unica de transacao por:

```javascript
      // Uma transacao por metodo de pagamento. Comanda com conta dividida
      // (metade cartao, metade dinheiro) precisa das duas linhas: sem isso a
      // conferencia da gaveta nunca fecha e o relatorio por forma de pagamento
      // fica errado.
      const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      const pagamentos = comanda.pagamentos || []

      if (pagamentos.length > 0) {
        for (const pg of pagamentos) {
          await transacaoRepo.create({
            id: uuidv4(),
            empresa_id: ctx.empresa_id,
            tipo: 'receita',
            categoria: 'Vendas',
            descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero}) - ${pg.metodo}`,
            valor: pg.valor,
            pedido_id: pedido.id,
            comanda_id: comanda.id,
            forma_pagamento: pg.metodo,
            caixa_id: caixaAberto ? caixaAberto.id : null,
            data: new Date(),
            created_at: new Date(),
          })
        }
      } else {
        // Comanda fechada sem registro de pagamento (fluxo antigo): mantem o
        // comportamento atual, uma transacao unica, assumindo dinheiro.
        await transacaoRepo.create({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Comanda ${comanda.mesa_nome} (Pedido #${numero})`,
          valor: totals.total,
          pedido_id: pedido.id,
          comanda_id: comanda.id,
          forma_pagamento: 'dinheiro',
          caixa_id: caixaAberto ? caixaAberto.id : null,
          data: new Date(),
          created_at: new Date(),
        })
      }
```

Adicione `caixaRepo` a desestruturacao de `repos` no topo do handler, junto dos
outros repositorios ja desestruturados ali.

- [ ] **Step 2: Forma de pagamento e caixa no pedido concluido**

Localize a criacao de transacao ao concluir pedido (procure por
`descricao: \`Pedido #${pedido.numero}\``). Acrescente os dois campos:

```javascript
        const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
        await transacaoRepo.create({
          id: uuidv4(),
          empresa_id: ctx.empresa_id,
          tipo: 'receita',
          categoria: 'Vendas',
          descricao: `Pedido #${pedido.numero}`,
          valor: totalFinal,
          pedido_id: pedido.id,
          forma_pagamento: pedido.pagamento || 'dinheiro',
          caixa_id: caixaAberto ? caixaAberto.id : null,
          data: new Date(),
          created_at: new Date(),
        })
```

- [ ] **Step 3: Verificar no navegador**

Suba o ambiente local, conclua um pedido em dinheiro e feche uma comanda com dois
metodos de pagamento. Consulte as transacoes geradas e confirme: o pedido gerou
uma linha com `forma_pagamento` igual ao metodo do pedido, e a comanda gerou duas
linhas cuja soma bate com o total.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "fix: uma transacao por metodo de pagamento, com forma_pagamento e caixa_id"
```

---

### Task 7: Endpoints de abertura, consulta e historico

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `computeCaixaEsperado` de `lib/caixa.js`; `caixaRepo`, `caixaMovimentoRepo`, `transacaoRepo`
- Produces: `GET /caixa/atual`, `POST /caixa/abrir`, `GET /caixa/historico`

Siga o padrao de rota do arquivo (o mesmo usado por `/entregadores`): checagem de
papel com o helper `can()` quando disponivel, `json()` para sucesso, `err()` para
400, e chamada a `audit()` nas operacoes que mudam estado.

- [ ] **Step 1: Importar o modulo de calculo**

No topo de `route.js`, junto dos outros imports de `lib/`:

```javascript
import { computeCaixaEsperado } from '@/lib/caixa'
```

Confira como os outros imports de `lib/` estao escritos neste arquivo e use a
mesma forma (alias `@/` ou caminho relativo).

- [ ] **Step 2: Criar o helper que monta o resumo do caixa**

Adicione junto das outras funcoes auxiliares do arquivo, **fora** do handler:

```javascript
/**
 * Monta o resumo financeiro de um caixa: quanto deveria haver na gaveta e o
 * total por forma de pagamento. Usado pelo GET /caixa/atual, pelo fechamento e
 * pela validacao de sangria — os tres precisam exatamente do mesmo numero.
 */
async function resumoDoCaixa(repos, empresaId, caixa) {
  const [transacoes, movimentos] = await Promise.all([
    repos.transacaoRepo.findByCaixa(empresaId, caixa.id),
    repos.caixaMovimentoRepo.listByCaixa(empresaId, caixa.id),
  ])
  return computeCaixaEsperado({
    valor_abertura: caixa.valor_abertura,
    transacoes,
    movimentos,
  })
}
```

- [ ] **Step 3: Implementar `GET /caixa/atual`**

```javascript
    // GET /caixa/atual — caixa aberto com os parciais calculados, ou null.
    if (seg[0] === 'caixa' && seg[1] === 'atual' && method === 'GET') {
      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return json({ caixa: null, resumo: null, movimentos: [] })
      const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
      const movimentos = await caixaMovimentoRepo.listByCaixa(ctx.empresa_id, caixa.id)
      return json({ caixa, resumo, movimentos })
    }
```

- [ ] **Step 4: Implementar `POST /caixa/abrir`**

```javascript
    // POST /caixa/abrir — GERENTE+. 409 se ja houver caixa aberto.
    if (seg[0] === 'caixa' && seg[1] === 'abrir' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para abrir caixa', 403)
      }
      const valorAbertura = Number(b.valor_abertura)
      if (!Number.isFinite(valorAbertura) || valorAbertura < 0) {
        return err('valor_abertura invalido')
      }

      const jaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      if (jaAberto) return err('Ja existe um caixa aberto', 409)

      const caixa = await caixaRepo.create({
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        status: 'aberto',
        aberto_por: ctx.usuario_id,
        aberto_por_nome: ctx.nome || '',
        aberto_em: new Date().toISOString(),
        valor_abertura: Math.round(valorAbertura * 100) / 100,
        created_at: new Date().toISOString(),
      })

      await audit(repos, ctx, 'abrir', 'caixa', caixa.id, { valor_abertura: caixa.valor_abertura })
      return json({ caixa })
    }
```

Confira em outro endpoint do arquivo como o nome do usuario logado esta
disponivel no `ctx` e use o mesmo campo — se `ctx.nome` nao existir, leia o
usuario pelo `usuarioRepo` antes de gravar o snapshot do nome.

- [ ] **Step 5: Implementar `GET /caixa/historico`**

```javascript
    // GET /caixa/historico — GERENTE+. Caixas fechados, mais recentes primeiro.
    if (seg[0] === 'caixa' && seg[1] === 'historico' && method === 'GET') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao', 403)
      }
      const limiteBruto = Number(url.searchParams.get('limite'))
      const limite = Number.isFinite(limiteBruto) && limiteBruto > 0 ? Math.min(limiteBruto, 100) : 20
      const caixas = await caixaRepo.listarFechados(ctx.empresa_id, limite)
      return json({ caixas })
    }
```

Confira como os outros endpoints deste arquivo leem query string e use a mesma
forma.

- [ ] **Step 6: Verificar no navegador**

Chame `GET /api/caixa/atual` sem caixa aberto e confirme `caixa: null`. Abra um
caixa com fundo de troco 100, chame de novo e confirme que `resumo.valor_esperado`
vem 100. Tente abrir um segundo caixa e confirme o 409.

- [ ] **Step 7: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: endpoints de abertura, consulta e historico de caixa"
```

---

### Task 8: Endpoints de fechamento e movimento

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `resumoDoCaixa(repos, empresaId, caixa)` da Task 7
- Produces: `POST /caixa/fechar`, `POST /caixa/movimento`

- [ ] **Step 1: Implementar `POST /caixa/fechar`**

```javascript
    // POST /caixa/fechar — GERENTE+. Calcula esperado, grava diferenca.
    if (seg[0] === 'caixa' && seg[1] === 'fechar' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para fechar caixa', 403)
      }
      const valorContado = Number(b.valor_contado)
      if (!Number.isFinite(valorContado) || valorContado < 0) {
        return err('valor_contado invalido')
      }

      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return err('Nao ha caixa aberto', 409)

      const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
      const contado = Math.round(valorContado * 100) / 100
      const diferenca = Math.round((contado - resumo.valor_esperado) * 100) / 100

      // Quebra de caixa exige justificativa. O sistema registra e segue — o que
      // fazer com a diferenca e decisao do dono, nao do software.
      const observacoes = (b.observacoes || '').trim()
      if (diferenca !== 0 && !observacoes) {
        return err('Informe uma observacao explicando a diferenca do caixa')
      }

      const fechado = await caixaRepo.update(ctx.empresa_id, caixa.id, {
        status: 'fechado',
        fechado_por: ctx.usuario_id,
        fechado_por_nome: ctx.nome || '',
        fechado_em: new Date().toISOString(),
        valor_contado: contado,
        valor_esperado: resumo.valor_esperado,
        diferenca,
        observacoes,
      })

      await audit(repos, ctx, 'fechar', 'caixa', caixa.id, {
        valor_esperado: resumo.valor_esperado, valor_contado: contado, diferenca,
      })
      return json({ caixa: fechado, resumo })
    }
```

- [ ] **Step 2: Implementar `POST /caixa/movimento`**

```javascript
    // POST /caixa/movimento — GERENTE+. Sangria ou suprimento no caixa aberto.
    if (seg[0] === 'caixa' && seg[1] === 'movimento' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para registrar movimento', 403)
      }
      if (!['sangria', 'suprimento'].includes(b.tipo)) {
        return err('tipo deve ser sangria ou suprimento')
      }
      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')

      const caixa = await caixaRepo.findAberto(ctx.empresa_id)
      if (!caixa) return err('Nao ha caixa aberto', 409)

      // Nao se tira da gaveta mais do que ha nela.
      if (b.tipo === 'sangria') {
        const resumo = await resumoDoCaixa(repos, ctx.empresa_id, caixa)
        if (valor > resumo.valor_esperado) {
          return err(`Sangria maior que o disponivel na gaveta (R$ ${resumo.valor_esperado.toFixed(2)})`)
        }
      }

      const movimento = await caixaMovimentoRepo.create({
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        caixa_id: caixa.id,
        tipo: b.tipo,
        valor: Math.round(valor * 100) / 100,
        motivo: b.motivo || '',
        usuario_id: ctx.usuario_id,
        usuario_nome: ctx.nome || '',
        created_at: new Date().toISOString(),
      })

      await audit(repos, ctx, 'registrar', 'caixa_movimento', movimento.id, {
        tipo: movimento.tipo, valor: movimento.valor,
      })
      return json({ movimento })
    }
```

- [ ] **Step 3: Verificar no navegador**

Com caixa aberto de 100: registre sangria de 30 e confirme que
`GET /caixa/atual` passa a mostrar 70. Tente sangria de 200 e confirme o erro
citando o disponivel. Feche com valor contado 70 e confirme `diferenca` zero.
Abra outro, feche com valor diferente do esperado sem observacao e confirme o 400.

- [ ] **Step 4: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: fechamento de caixa com conferencia e movimentos de sangria/suprimento"
```

---

### Task 9: Endpoint de estorno

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `transacaoRepo.findByPedido(empresaId, pedidoId)`, `caixaRepo.findAberto`
- Produces: `POST /pedidos/:id/estorno`

O `total` do pedido nunca muda. O acerto e um lancamento novo — exatamente o que
o comentario em `route.js:1135` ja orientava.

- [ ] **Step 1: Implementar o endpoint**

```javascript
    // POST /pedidos/:id/estorno — GERENTE+. Lancamento de contrapartida.
    if (seg[0] === 'pedidos' && seg[2] === 'estorno' && method === 'POST') {
      if (!['OWNER', 'ADMIN', 'GERENTE'].includes(ctx.papel)) {
        return err('Sem permissao para estornar', 403)
      }
      const pedido = await pedidoRepo.findById(ctx.empresa_id, seg[1])
      if (!pedido) return err('Pedido nao encontrado', 404)

      const finaisEstornaveis = ['concluido', 'ENTREGUE', 'entregue']
      if (!finaisEstornaveis.includes(pedido.status)) {
        return err('So pedidos concluidos podem ser estornados')
      }

      const valor = Number(b.valor)
      if (!Number.isFinite(valor) || valor <= 0) return err('valor deve ser maior que zero')

      const motivo = (b.motivo || '').trim()
      if (!motivo) return err('motivo e obrigatorio')

      // Estorno parcial e permitido, mas a soma dos estornos nunca passa do total.
      const doPedido = await transacaoRepo.findByPedido(ctx.empresa_id, pedido.id)
      const jaEstornado = doPedido
        .filter((t) => t.tipo === 'despesa' && t.categoria === 'Estorno')
        .reduce((s, t) => s + Number(t.valor || 0), 0)

      const valorArred = Math.round(valor * 100) / 100
      if (jaEstornado + valorArred > pedido.total) {
        const restante = Math.round((pedido.total - jaEstornado) * 100) / 100
        return err(`Estorno acima do disponivel. Restam R$ ${restante.toFixed(2)} deste pedido`)
      }

      const caixaAberto = await caixaRepo.findAberto(ctx.empresa_id)
      const estorno = await transacaoRepo.create({
        id: uuidv4(),
        empresa_id: ctx.empresa_id,
        tipo: 'despesa',
        categoria: 'Estorno',
        descricao: `Estorno do Pedido #${pedido.numero}: ${motivo}`,
        valor: valorArred,
        pedido_id: pedido.id,
        comanda_id: pedido.comanda_id || null,
        forma_pagamento: pedido.pagamento || 'dinheiro',
        caixa_id: caixaAberto ? caixaAberto.id : null,
        data: new Date(),
        created_at: new Date(),
      })

      await audit(repos, ctx, 'estornar', 'pedido', pedido.id, { valor: valorArred, motivo })
      return json({ estorno, total_estornado: Math.round((jaEstornado + valorArred) * 100) / 100 })
    }
```

- [ ] **Step 2: Verificar no navegador**

Conclua um pedido de R$ 50 em dinheiro com caixa aberto. Estorne R$ 20 e confirme
que `GET /caixa/atual` baixa 20 no esperado. Estorne mais R$ 40 e confirme o erro
citando que restam R$ 30. Tente estornar um pedido nao concluido e confirme o 400.

- [ ] **Step 3: Commit**

```bash
git add app/api/[[...path]]/route.js
git commit -m "feat: estorno de venda como lancamento de contrapartida"
```

---

### Task 10: UI — barra de caixa e abertura

**Files:**
- Modify: `app/page.js`

**Interfaces:**
- Consumes: `GET /caixa/atual`, `POST /caixa/abrir`
- Produces: estado `caixaAtual`, `caixaResumo`, `caixaMovimentos`; funcao `carregarCaixa()` reutilizada pelas tasks 11 e 12

Siga o estilo dos componentes ja existentes na tela Financeiro: os mesmos
componentes de card, botao e input usados no resto do arquivo, e o mesmo padrao
de toast para feedback.

- [ ] **Step 1: Estado e carregamento**

```javascript
const [caixaAtual, setCaixaAtual] = useState(null)
const [caixaResumo, setCaixaResumo] = useState(null)
const [caixaMovimentos, setCaixaMovimentos] = useState([])
const [caixaHistorico, setCaixaHistorico] = useState([])
const [dialogAbrirCaixa, setDialogAbrirCaixa] = useState(false)
const [valorAbertura, setValorAbertura] = useState('')

const carregarCaixa = useCallback(async () => {
  try {
    const atual = await api('/caixa/atual')
    setCaixaAtual(atual.caixa)
    setCaixaResumo(atual.resumo)
    setCaixaMovimentos(atual.movimentos || [])
    const hist = await api('/caixa/historico?limite=10')
    setCaixaHistorico(hist.caixas || [])
  } catch (e) {
    console.error(e)
  }
}, [])

useEffect(() => {
  if (telaAtiva === 'financeiro') carregarCaixa()
}, [telaAtiva, carregarCaixa])
```

Use o helper de fetch que o arquivo ja tem (procure por como as outras telas
chamam a API — se o helper se chama diferente de `api`, use o nome real).

- [ ] **Step 2: Handler de abertura**

```javascript
const handleAbrirCaixa = async () => {
  const valor = parseFloat(valorAbertura)
  if (!Number.isFinite(valor) || valor < 0) {
    toast({ title: 'Informe o fundo de troco', variant: 'destructive' })
    return
  }
  try {
    await api('/caixa/abrir', { method: 'POST', body: { valor_abertura: valor } })
    setDialogAbrirCaixa(false)
    setValorAbertura('')
    await carregarCaixa()
    toast({ title: 'Caixa aberto' })
  } catch (e) {
    toast({ title: 'Nao foi possivel abrir', description: e.message, variant: 'destructive' })
  }
}
```

- [ ] **Step 3: Barra de status no topo da tela Financeiro**

```jsx
{caixaAtual ? (
  <Card className="mb-4">
    <CardContent className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-muted-foreground">
            Caixa aberto desde {new Date(caixaAtual.aberto_em).toLocaleString('pt-BR')}
            {caixaAtual.aberto_por_nome ? ` por ${caixaAtual.aberto_por_nome}` : ''}
          </div>
          <div className="text-2xl font-semibold">
            R$ {(caixaResumo?.valor_esperado ?? 0).toFixed(2)}
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
  <Card className="mb-4">
    <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="text-sm text-muted-foreground">
        Caixa fechado. Abra o caixa para conferir o dinheiro no fim do dia.
      </div>
      <Button onClick={() => setDialogAbrirCaixa(true)}>Abrir caixa</Button>
    </CardContent>
  </Card>
)}
```

`abrirDialogMovimento` e `dialogFecharCaixa` sao criados na Task 11 — nesta task,
declare `const [dialogFecharCaixa, setDialogFecharCaixa] = useState(false)` e uma
`abrirDialogMovimento` vazia para a tela compilar, e a Task 11 as preenche.

- [ ] **Step 4: Dialogo de abertura**

```jsx
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
          Dinheiro que ja esta na gaveta agora, antes da primeira venda.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => setDialogAbrirCaixa(false)}>Cancelar</Button>
        <Button className="flex-1" onClick={handleAbrirCaixa}>Abrir</Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: Verificar no navegador**

Abra a tela Financeiro sem caixa aberto e confirme a barra com o botao "Abrir
caixa". Abra com fundo 100 e confirme que a barra passa a mostrar R$ 100,00 na
gaveta e os tres botoes.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "feat: barra de status do caixa e abertura na tela Financeiro"
```

---

### Task 11: UI — fechamento, movimentos e historico

**Files:**
- Modify: `app/page.js`

**Interfaces:**
- Consumes: `carregarCaixa()`, `caixaAtual`, `caixaResumo`, `caixaMovimentos`, `caixaHistorico` da Task 10
- Produces: dialogos de fechamento e de movimento; lista de historico

- [ ] **Step 1: Estado dos dialogos**

```javascript
const [dialogMovimento, setDialogMovimento] = useState(null) // 'sangria' | 'suprimento' | null
const [movimentoValor, setMovimentoValor] = useState('')
const [movimentoMotivo, setMovimentoMotivo] = useState('')
const [valorContado, setValorContado] = useState('')
const [obsFechamento, setObsFechamento] = useState('')

const abrirDialogMovimento = (tipo) => {
  setMovimentoValor('')
  setMovimentoMotivo('')
  setDialogMovimento(tipo)
}
```

Substitua a `abrirDialogMovimento` vazia deixada na Task 10 por esta.

- [ ] **Step 2: Handlers**

```javascript
const handleRegistrarMovimento = async () => {
  const valor = parseFloat(movimentoValor)
  if (!Number.isFinite(valor) || valor <= 0) {
    toast({ title: 'Informe um valor maior que zero', variant: 'destructive' })
    return
  }
  try {
    await api('/caixa/movimento', {
      method: 'POST',
      body: { tipo: dialogMovimento, valor, motivo: movimentoMotivo },
    })
    setDialogMovimento(null)
    await carregarCaixa()
    toast({ title: dialogMovimento === 'sangria' ? 'Sangria registrada' : 'Suprimento registrado' })
  } catch (e) {
    toast({ title: 'Nao foi possivel registrar', description: e.message, variant: 'destructive' })
  }
}

const handleFecharCaixa = async () => {
  const contado = parseFloat(valorContado)
  if (!Number.isFinite(contado) || contado < 0) {
    toast({ title: 'Informe o valor contado', variant: 'destructive' })
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
    toast({ title: 'Caixa fechado' })
  } catch (e) {
    toast({ title: 'Nao foi possivel fechar', description: e.message, variant: 'destructive' })
  }
}
```

- [ ] **Step 3: Dialogo de movimento**

```jsx
<Dialog open={dialogMovimento !== null} onOpenChange={(v) => !v && setDialogMovimento(null)}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>{dialogMovimento === 'sangria' ? 'Sangria' : 'Suprimento'}</DialogTitle>
    </DialogHeader>
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {dialogMovimento === 'sangria'
          ? 'Retirada de dinheiro da gaveta para o cofre ou o banco. Nao e despesa.'
          : 'Entrada de dinheiro na gaveta, geralmente troco. Nao e receita.'}
      </p>
      <div>
        <Label>Valor (R$)</Label>
        <Input type="number" min="0" step="0.01" value={movimentoValor}
          onChange={(e) => setMovimentoValor(e.target.value)} placeholder="0,00" />
      </div>
      <div>
        <Label>Motivo</Label>
        <Input value={movimentoMotivo} onChange={(e) => setMovimentoMotivo(e.target.value)}
          placeholder="ex: deposito no banco" />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => setDialogMovimento(null)}>Cancelar</Button>
        <Button className="flex-1" onClick={handleRegistrarMovimento}>Registrar</Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Dialogo de fechamento com diferenca ao vivo**

```jsx
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
                  <span className="capitalize">{forma === 'nao_informado' ? 'nao informado' : forma}</span>
                  <span>R$ {valor.toFixed(2)}</span>
                </div>
              ))
            )}
          </div>

          <div className="rounded-md border p-3 text-sm">
            <div className="flex justify-between"><span>Fundo de troco</span><span>R$ {(caixaResumo?.valor_abertura ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span>+ Vendas em dinheiro</span><span>R$ {(caixaResumo?.receitas_dinheiro ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span>- Estornos em dinheiro</span><span>R$ {(caixaResumo?.estornos_dinheiro ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span>+ Suprimentos</span><span>R$ {(caixaResumo?.suprimentos ?? 0).toFixed(2)}</span></div>
            <div className="flex justify-between"><span>- Sangrias</span><span>R$ {(caixaResumo?.sangrias ?? 0).toFixed(2)}</span></div>
            <div className="mt-2 flex justify-between border-t pt-2 font-semibold">
              <span>Esperado na gaveta</span><span>R$ {esperado.toFixed(2)}</span>
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
                : diferenca > 0 ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-red-500/10 text-red-700 dark:text-red-400'
            }`}>
              {diferenca === 0
                ? 'Caixa confere exatamente.'
                : diferenca > 0
                  ? `Sobra de R$ ${diferenca.toFixed(2)}`
                  : `Falta de R$ ${Math.abs(diferenca).toFixed(2)}`}
            </div>
          )}

          <div>
            <Label>Observacoes {temContado && diferenca !== 0 ? '(obrigatorio)' : '(opcional)'}</Label>
            <Textarea value={obsFechamento} onChange={(e) => setObsFechamento(e.target.value)}
              placeholder="O que explica a diferenca?" rows={3} />
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
```

- [ ] **Step 5: Lista de movimentos do caixa aberto e historico**

Abaixo da barra de status, na tela Financeiro:

```jsx
{caixaAtual && caixaMovimentos.length > 0 && (
  <Card className="mb-4">
    <CardHeader><CardTitle className="text-base">Movimentos deste caixa</CardTitle></CardHeader>
    <CardContent className="space-y-1 text-sm">
      {caixaMovimentos.map((m) => (
        <div key={m.id} className="flex justify-between">
          <span>
            {m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}
            {m.motivo ? ` — ${m.motivo}` : ''}
            <span className="ml-2 text-xs text-muted-foreground">{m.usuario_nome}</span>
          </span>
          <span className={m.tipo === 'sangria' ? 'text-red-600' : 'text-green-600'}>
            {m.tipo === 'sangria' ? '-' : '+'} R$ {m.valor.toFixed(2)}
          </span>
        </div>
      ))}
    </CardContent>
  </Card>
)}

<Card>
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
                Esperado R$ {(c.valor_esperado ?? 0).toFixed(2)} · Contado R$ {(c.valor_contado ?? 0).toFixed(2)}
              </div>
              <div className={`font-medium ${
                (c.diferenca ?? 0) === 0 ? '' : (c.diferenca ?? 0) > 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {(c.diferenca ?? 0) === 0 ? 'Conferiu' : `Diferenca R$ ${(c.diferenca ?? 0).toFixed(2)}`}
              </div>
            </div>
          </div>
        ))}
      </div>
    )}
  </CardContent>
</Card>
```

- [ ] **Step 6: Verificar no navegador**

Com caixa aberto de 100: registre sangria de 30, confirme que aparece na lista de
movimentos e que a barra passa a 70. Abra o fechamento, digite 70 e confirme
"Caixa confere exatamente". Digite 65 e confirme a falta de R$ 5,00 em vermelho e
o botao bloqueado ate escrever a observacao. Feche e confirme a linha no historico.

- [ ] **Step 7: Commit**

```bash
git add app/page.js
git commit -m "feat: fechamento de caixa com conferencia ao vivo, movimentos e historico"
```

---

### Task 12: UI — estorno e aviso de caixa fechado

**Files:**
- Modify: `app/page.js`

**Interfaces:**
- Consumes: `POST /pedidos/:id/estorno`, `carregarCaixa()`
- Produces: dialogo de estorno no pedido concluido; aviso ao concluir venda sem caixa aberto

- [ ] **Step 1: Estado e handler do estorno**

```javascript
const [pedidoEstorno, setPedidoEstorno] = useState(null)
const [estornoValor, setEstornoValor] = useState('')
const [estornoMotivo, setEstornoMotivo] = useState('')

const abrirDialogEstorno = (pedido) => {
  setEstornoValor(String(pedido.total ?? ''))
  setEstornoMotivo('')
  setPedidoEstorno(pedido)
}

const handleEstornar = async () => {
  const valor = parseFloat(estornoValor)
  if (!Number.isFinite(valor) || valor <= 0) {
    toast({ title: 'Informe um valor maior que zero', variant: 'destructive' })
    return
  }
  if (!estornoMotivo.trim()) {
    toast({ title: 'Informe o motivo do estorno', variant: 'destructive' })
    return
  }
  try {
    await api(`/pedidos/${pedidoEstorno.id}/estorno`, {
      method: 'POST',
      body: { valor, motivo: estornoMotivo },
    })
    setPedidoEstorno(null)
    await carregarPedidos()
    await carregarCaixa()
    toast({ title: 'Estorno registrado' })
  } catch (e) {
    toast({ title: 'Nao foi possivel estornar', description: e.message, variant: 'destructive' })
  }
}
```

Use o nome real da funcao que recarrega os pedidos neste arquivo no lugar de
`carregarPedidos`.

- [ ] **Step 2: Botao de estorno no pedido concluido**

Na area de acoes do card de pedido, junto dos botoes que ja existem:

```jsx
{['concluido', 'ENTREGUE', 'entregue'].includes(pedido.status) && podeGerenciar && (
  <Button variant="outline" size="sm" onClick={() => abrirDialogEstorno(pedido)}>
    Estornar
  </Button>
)}
```

`podeGerenciar` deve refletir papel GERENTE ou acima — reuse a variavel que o
arquivo ja usa para esconder acoes de gerencia; se nao existir, compare
`usuario.papel` com `['OWNER', 'ADMIN', 'GERENTE']`.

- [ ] **Step 3: Dialogo de estorno**

```jsx
<Dialog open={pedidoEstorno !== null} onOpenChange={(v) => !v && setPedidoEstorno(null)}>
  <DialogContent>
    <DialogHeader><DialogTitle>Estornar pedido #{pedidoEstorno?.numero}</DialogTitle></DialogHeader>
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        O valor do pedido nao muda. O estorno entra como lancamento separado no
        financeiro, preservando o historico da venda.
      </p>
      <div>
        <Label>Valor a estornar (R$)</Label>
        <Input type="number" min="0" step="0.01" value={estornoValor}
          onChange={(e) => setEstornoValor(e.target.value)} />
        <p className="mt-1 text-xs text-muted-foreground">
          Total do pedido: R$ {(pedidoEstorno?.total ?? 0).toFixed(2)}. Estorno parcial e permitido.
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
```

- [ ] **Step 4: Aviso ao concluir venda sem caixa aberto**

Na funcao que conclui um pedido (a que muda status para concluido), depois do
sucesso:

```javascript
  if (!caixaAtual) {
    toast({
      title: 'Caixa fechado',
      description: 'Esta venda nao entrara em nenhuma conferencia de caixa.',
    })
  }
```

A venda acontece normalmente — o aviso so informa. Bloquear a venda porque
alguem esqueceu de abrir o caixa seria pior que a falha.

- [ ] **Step 5: Verificar no navegador**

Conclua um pedido com caixa fechado e confirme o aviso. Abra o caixa, conclua
outro pedido de R$ 50 em dinheiro, estorne R$ 20 com motivo e confirme que a
barra do caixa baixa de 50 para 30. Confirme que estornar sem motivo e bloqueado.

- [ ] **Step 6: Commit**

```bash
git add app/page.js
git commit -m "feat: estorno de pedido na interface e aviso de caixa fechado"
```

---

### Task 13: Suite de testes de API

**Files:**
- Create: `backend_test_caixa.py`

**Interfaces:**
- Consumes: todos os endpoints das tasks 7, 8 e 9

Siga a estrutura de `backend_test_kds.py`: `BASE_URL` por variavel de ambiente,
helpers `log_pass`/`log_fail`, criacao de empresa e usuario proprios para o teste,
e resumo no fim.

- [ ] **Step 1: Escrever a suite**

Criar `backend_test_caixa.py`:

```python
#!/usr/bin/env python3
"""
Restaurant OS - Suite de testes do Caixa
Cobre: abertura, fechamento, conferencia, sangria, suprimento, estorno,
forma de pagamento na transacao e isolamento multi-tenant.
"""

import os
import random
import string
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


def rand(prefixo):
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefixo}.{s}@teste.com"


def criar_empresa():
    """Cria empresa + usuario OWNER e devolve (headers, empresa_id)."""
    email = rand("caixa")
    r = requests.post(f"{BASE_URL}/auth/registrar", json={
        "nome_empresa": f"Caixa Teste {email[:12]}",
        "nome": "Dono Teste",
        "email": email,
        "senha": "senha123456",
    })
    r.raise_for_status()
    dados = r.json()
    token = dados["token"]
    return {"Authorization": f"Bearer {token}"}, dados.get("empresa", {}).get("id")


def criar_pedido_concluido(headers, valor, pagamento="dinheiro"):
    """Cria produto, pedido e conclui. Devolve o pedido concluido."""
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Item Teste", "preco": valor, "disponivel": True,
    }).json()
    produto = prod.get("produto", prod)

    ped = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "balcao",
        "pagamento": pagamento,
        "itens": [{"produto_id": produto["id"], "nome": produto["nome"],
                   "preco": valor, "quantidade": 1}],
    }).json()
    pedido = ped.get("pedido", ped)

    requests.patch(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers,
                   json={"status": "concluido"})
    return pedido


def main():
    headers, _ = criar_empresa()

    # --- abertura ---
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r.json().get("caixa") is None:
        log_pass("caixa/atual devolve null quando nao ha caixa aberto")
    else:
        log_fail("caixa/atual devolve null quando nao ha caixa aberto", r.text)

    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 100})
    if r.status_code == 200 and r.json()["caixa"]["valor_abertura"] == 100:
        log_pass("abrir caixa com fundo de troco")
    else:
        log_fail("abrir caixa com fundo de troco", r.text)

    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 50})
    if r.status_code == 409:
        log_pass("abrir segundo caixa retorna 409")
    else:
        log_fail("abrir segundo caixa retorna 409", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": -5})
    if r.status_code == 400:
        log_pass("valor_abertura negativo retorna 400")
    else:
        log_fail("valor_abertura negativo retorna 400", f"status {r.status_code}")

    # --- venda em dinheiro entra na gaveta ---
    criar_pedido_concluido(headers, 50, "dinheiro")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    esperado = r.json()["resumo"]["valor_esperado"]
    if esperado == 150:
        log_pass("venda em dinheiro entra no esperado (100 + 50)")
    else:
        log_fail("venda em dinheiro entra no esperado (100 + 50)", f"esperado 150, veio {esperado}")

    # --- venda em pix NAO entra na gaveta ---
    criar_pedido_concluido(headers, 80, "pix")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    resumo = r.json()["resumo"]
    if resumo["valor_esperado"] == 150:
        log_pass("venda em pix nao altera o esperado da gaveta")
    else:
        log_fail("venda em pix nao altera o esperado da gaveta", f"veio {resumo['valor_esperado']}")
    if resumo["por_forma_pagamento"].get("pix") == 80:
        log_pass("venda em pix aparece no resumo por forma de pagamento")
    else:
        log_fail("venda em pix aparece no resumo por forma de pagamento", str(resumo))

    # --- sangria e suprimento ---
    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                      json={"tipo": "sangria", "valor": 30, "motivo": "deposito"})
    if r.status_code == 200:
        log_pass("registrar sangria")
    else:
        log_fail("registrar sangria", r.text)

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.json()["resumo"]["valor_esperado"] == 120:
        log_pass("sangria reduz o esperado (150 - 30)")
    else:
        log_fail("sangria reduz o esperado (150 - 30)", str(r.json()["resumo"]))

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                      json={"tipo": "sangria", "valor": 9999, "motivo": "demais"})
    if r.status_code == 400:
        log_pass("sangria maior que o disponivel retorna 400")
    else:
        log_fail("sangria maior que o disponivel retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                      json={"tipo": "suprimento", "valor": 10, "motivo": "troco"})
    r2 = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r2.json()["resumo"]["valor_esperado"] == 130:
        log_pass("suprimento aumenta o esperado (120 + 10)")
    else:
        log_fail("suprimento aumenta o esperado (120 + 10)", r.text)

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                      json={"tipo": "invalido", "valor": 10})
    if r.status_code == 400:
        log_pass("tipo de movimento invalido retorna 400")
    else:
        log_fail("tipo de movimento invalido retorna 400", f"status {r.status_code}")

    # --- estorno ---
    pedido = criar_pedido_concluido(headers, 40, "dinheiro")
    r = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno", headers=headers,
                      json={"valor": 15, "motivo": "cliente desistiu"})
    if r.status_code == 200:
        log_pass("estornar parcialmente um pedido concluido")
    else:
        log_fail("estornar parcialmente um pedido concluido", r.text)

    r = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno", headers=headers,
                      json={"valor": 100, "motivo": "acima do total"})
    if r.status_code == 400:
        log_pass("estorno acumulado acima do total retorna 400")
    else:
        log_fail("estorno acumulado acima do total retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno", headers=headers,
                      json={"valor": 5})
    if r.status_code == 400:
        log_pass("estorno sem motivo retorna 400")
    else:
        log_fail("estorno sem motivo retorna 400", f"status {r.status_code}")

    # --- fechamento ---
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    esperado_final = r.json()["resumo"]["valor_esperado"]

    r = requests.post(f"{BASE_URL}/caixa/fechar", headers=headers,
                      json={"valor_contado": esperado_final - 5})
    if r.status_code == 400:
        log_pass("fechar com diferenca sem observacao retorna 400")
    else:
        log_fail("fechar com diferenca sem observacao retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/fechar", headers=headers,
                      json={"valor_contado": esperado_final})
    if r.status_code == 200 and r.json()["caixa"]["diferenca"] == 0:
        log_pass("fechar com valor exato registra diferenca zero")
    else:
        log_fail("fechar com valor exato registra diferenca zero", r.text)

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                      json={"tipo": "sangria", "valor": 10})
    if r.status_code == 409:
        log_pass("movimento sem caixa aberto retorna 409")
    else:
        log_fail("movimento sem caixa aberto retorna 409", f"status {r.status_code}")

    r = requests.get(f"{BASE_URL}/caixa/historico", headers=headers)
    if r.status_code == 200 and len(r.json()["caixas"]) == 1:
        log_pass("historico lista o caixa fechado")
    else:
        log_fail("historico lista o caixa fechado", r.text)

    # --- isolamento multi-tenant ---
    headers_b, _ = criar_empresa()
    r = requests.get(f"{BASE_URL}/caixa/historico", headers=headers_b)
    if r.status_code == 200 and len(r.json()["caixas"]) == 0:
        log_pass("empresa B nao ve caixas da empresa A")
    else:
        log_fail("empresa B nao ve caixas da empresa A", r.text)

    r = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno", headers=headers_b,
                      json={"valor": 5, "motivo": "tentativa cross-tenant"})
    if r.status_code == 404:
        log_pass("estornar pedido de outra empresa retorna 404")
    else:
        log_fail("estornar pedido de outra empresa retorna 404", f"status {r.status_code}")

    # --- venda sem caixa aberto ---
    pedido_sem_caixa = criar_pedido_concluido(headers, 25, "dinheiro")
    if pedido_sem_caixa.get("id"):
        log_pass("venda com caixa fechado acontece normalmente")
    else:
        log_fail("venda com caixa fechado acontece normalmente", str(pedido_sem_caixa))

    print(f"\n{len(results['passed'])} passaram, {len(results['failed'])} falharam")
    if results["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
```

Os nomes de rota e os formatos de resposta usados aqui (`/auth/registrar`,
`/produtos`, `/pedidos`) precisam bater com os reais — confira em
`backend_test_kds.py` como aquela suite cria empresa, produto e pedido, e ajuste
estes helpers para os mesmos caminhos e chaves de resposta.

- [ ] **Step 2: Rodar contra o ambiente local**

Run: `python3 backend_test_caixa.py`
Expected: todos PASS, saida sem erro

- [ ] **Step 3: Rodar a suite existente para confirmar que nada quebrou**

A Task 6 mudou como as transacoes de venda nascem. Rode as suites que ja existiam:

Run: `python3 backend_test_v3.py`
Expected: mesmo resultado de antes da mudanca (baseline 32/33)

- [ ] **Step 4: Commit**

```bash
git add backend_test_caixa.py
git commit -m "test: suite de testes do caixa (abertura, fechamento, movimentos, estorno)"
```

---

### Task 14: Documentacao e fecho

**Files:**
- Modify: `HANDOFF.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Atualizar o HANDOFF**

Em `HANDOFF.md`, no bloco de retomada (§0), acrescentar depois do bloco do
Delivery:

```markdown
**CAIXA — COMPLETO**

Abertura e fechamento de caixa com conferencia, sangria, suprimento e estorno
de venda. Plano: `docs/superpowers/plans/2026-08-13-caixa-implementation.md`.

- Migration 0018: tabelas `caixas` e `caixa_movimentos`; `transacoes` ganhou
  `forma_pagamento` e `caixa_id`
- Calculo do esperado em `lib/caixa.js` (modulo puro, testado por
  `test_caixa_calculo.mjs`)
- Endpoints: `/caixa/atual`, `/caixa/abrir`, `/caixa/fechar`,
  `/caixa/movimento`, `/caixa/historico`, `/pedidos/:id/estorno`
- UI na aba Financeiro: barra de status, dialogos de abertura, movimento e
  fechamento com diferenca ao vivo, historico de caixas
- Testes: `backend_test_caixa.py`

**Correcao estrutural incluida:** comanda paga com dois metodos agora gera duas
transacoes, uma por metodo. Antes gravava so o primeiro e o resto se perdia
(`route.js:1635`), o que impedia qualquer conferencia de fechar.
```

Na secao 11, marcar a linha de fechamento de caixa como feita:

```markdown
- [x] ~~Fechamento de caixa~~ — **implementado em 2026-08-13** (abertura,
      fechamento com conferencia, sangria, suprimento e estorno de venda).
```

- [ ] **Step 2: Atualizar o ROADMAP**

Em `docs/ROADMAP.md`, mover o item 1 (Caixa) da secao "Proximo" para a tabela
"Entregue" com a data 2026-08-13, e renumerar os itens restantes.

- [ ] **Step 3: Commit e push**

```bash
git add HANDOFF.md docs/ROADMAP.md
git commit -m "docs: caixa completo no handoff e no roadmap"
git push origin main
```

---

## Resumo

14 tasks: schema e contratos (1), calculo puro com TDD (2), repositorios nos dois
backends (3-5), correcao da forma de pagamento na origem (6), endpoints (7-9), UI
(10-12), testes (13) e documentacao (14).

A ordem importa: o calculo puro vem antes dos endpoints porque os tres pontos que
precisam do valor esperado (consulta, fechamento, validacao de sangria) chamam a
mesma funcao. A correcao da forma de pagamento vem antes dos endpoints de caixa
porque sem ela o valor esperado nunca fecha.
