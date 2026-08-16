# Custo e Margem (CMV) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar custo ao produto e derivar dele CMV%, cobertura e lucro bruto no Dashboard e no Relatorio financeiro.

**Architecture:** O custo e congelado na `transacao` no momento da venda — nao no item — o que evita reescrever as funcoes atomicas do Postgres e ainda preserva a historia. A formula vive num modulo puro (`lib/custo.js`), testavel sem banco e sem navegador, no mesmo padrao de `lib/caixa.js`. Produto sem custo cadastrado sai do calculo e aparece como lacuna de cobertura, nunca como custo zero.

**Tech Stack:** Supabase (Postgres) + MongoDB, Next.js App Router, React + Tailwind, testes puros em Node (`node file.mjs`) e testes de API em Python (`requests`).

**Spec:** `docs/superpowers/specs/2026-08-14-custo-margem-design.md`

## Global Constraints

- `produtos.custo` e `numeric(12,2) default null` — `null` = nao cadastrado (fora do calculo, conta contra a cobertura); `0` = custo zero real (brinde) e **entra** no calculo
- `transacoes.custo_total`, `.receita_com_custo`, `.receita_base` sao `numeric(12,2) not null default 0`
- **Formula:** `CMV% = custo_total / receita_com_custo`; `cobertura% = receita_com_custo / receita_base`; `lucro_bruto = receita_com_custo - custo_total`
- `cmv_percent`, `cobertura_percent` e `lucro_bruto` sao **`null`**, nunca `0`, quando o denominador e zero
- **Estorno nao devolve custo** — `POST /pedidos/:id/estorno` grava os tres campos em `0`
- `receita_base` e o **subtotal dos itens** (`preco * quantidade`). Desconto, acrescimo e taxa de entrega **nao** entram em nenhum dos tres campos
- Item sem `produto_id` (avulso) entra so em `receita_base`, nunca em custo
- **Falha na apuracao nao derruba a venda**: grava o que conseguiu, registra em `auditoria`, segue
- **Nenhuma migracao retroativa** — transacao antiga fica com os tres campos em `0` e sai da conta naturalmente
- Todo valor monetario passa por `round2` a cada etapa, para centavos nao acumularem erro de ponto flutuante
- **Nenhuma funcao atomica do Postgres e tocada** por este plano

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/0020_custo.sql` | **novo** — 1 coluna em `produtos`, 3 em `transacoes` |
| `lib/custo.js` | **novo** — modulo puro: apuracao por venda e agregacao em indicadores |
| `test_custo_calculo.mjs` | **novo** — 10 testes puros, rodam sem banco |
| `packages/domain/src/index.ts` | contratos: `Produto.custo`, 3 campos em `Transacao` |
| `lib/repositories/mongo/transacaoRepository.js` | `normalize()` precisa repassar os 3 campos novos |
| `app/api/[[...path]]/route.js` | helper de leitura de custo, 3 pontos de gravacao, 2 endpoints |
| `app/page.js` | campo no dialog do produto, cards no Dashboard, KPIs no Relatorio + CSV |
| `backend_test_custo.py` | **novo** — 8 testes de integracao |

**Descoberta de leitura de codigo que reduz o escopo:** os repositorios de
`produtos` e `transacoes` **nao precisam de mudanca para propagar os campos
novos**. Nos dois backends, `create()` grava a entidade inteira
(`insert(entity)` / `insertOne(entity)`) e `update()` aplica o patch inteiro
(`update(patch)` / `$set: patch`); no Supabase as leituras usam `select('*')`.
A **unica** excecao e `normalize()` em `lib/repositories/mongo/transacaoRepository.js`,
que monta o objeto campo a campo e descartaria os tres novos — tratado na Task 1.
Isso corrige a §11 da spec, escrita antes desta leitura.

---

### Task 1: Schema, contratos e normalize do Mongo

**Files:**
- Create: `supabase/migrations/0020_custo.sql`
- Modify: `packages/domain/src/index.ts`
- Modify: `lib/repositories/mongo/transacaoRepository.js:3-19`

**Interfaces:**
- Consumes: nada de tasks anteriores
- Produces: coluna `produtos.custo`; colunas `transacoes.custo_total`, `.receita_com_custo`, `.receita_base`; os mesmos campos nos tipos `Produto` e `Transacao`

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/0020_custo.sql`:

```sql
-- ============================================================================
-- Restaurant OS :: Migration 0020 :: Custo e Margem (CMV)
-- ============================================================================
-- Custo unitario do produto e apuracao congelada na transacao.
--
-- Por que o custo mora na transacao e nao no item: a transacao ja e a fonte
-- unica de verdade financeira e e criada por transacaoRepo.create() direto,
-- fora das funcoes atomicas create_pedido_com_itens()/create_comanda_com_itens(),
-- que usam lista explicita de colunas. Congelar aqui da precisao historica sem
-- tocar na parte mais fragil do schema.

-- NULL = nao cadastrado: fica fora do CMV e conta contra a cobertura.
-- 0 = custo zero real (brinde, cortesia) e ENTRA no calculo.
-- Sem essa distincao todo produto nasceria "de graca" e o CMV do primeiro dia
-- sairia lindo e falso.
alter table public.produtos
  add column if not exists custo numeric(12,2) default null
    check (custo is null or custo >= 0);

-- Congelado na venda: mudar o custo do produto amanha nao reescreve o CMV de
-- hoje. Transacoes anteriores a esta migration ficam em 0 e saem da conta
-- naturalmente, porque receita_com_custo = 0 (sem migracao retroativa).
alter table public.transacoes
  add column if not exists custo_total       numeric(12,2) not null default 0,
  add column if not exists receita_com_custo numeric(12,2) not null default 0,
  add column if not exists receita_base      numeric(12,2) not null default 0;
```

Nenhum indice novo: as consultas de CMV agregam sobre `(empresa_id, data)`, que
ja tem `idx_transacoes_data`.

- [ ] **Step 2: Atualizar os contratos de dominio**

Em `packages/domain/src/index.ts`, adicionar o campo a interface `Produto`
existente (logo apos `estoque_minimo`):

```typescript
  /**
   * Custo unitario. `null` = nao cadastrado: fica fora do CMV e conta contra
   * a cobertura. `0` = custo zero real (brinde, cortesia) e entra no calculo.
   * A distincao e o que impede o CMV de mentir para baixo.
   */
  custo: number | null;
```

E a interface `Transacao` existente (logo apos `caixa_id`):

```typescript
  /**
   * Custo apurado no momento da venda. Congelado: mudar o custo do produto
   * amanha nao reescreve o CMV de hoje. Transacoes anteriores a migration
   * 0020 tem 0 — nao ha dado de onde inferir o custo, e inventar um falsearia
   * o indicador.
   */
  custo_total: number;
  /** Receita dos itens que tinham custo. Denominador do CMV. */
  receita_com_custo: number;
  /** Receita de TODOS os itens. Denominador da cobertura. */
  receita_base: number;
```

- [ ] **Step 3: Repassar os campos no normalize do Mongo**

Em `lib/repositories/mongo/transacaoRepository.js`, a funcao `normalize()` monta
o objeto campo a campo e descartaria os tres novos. Adicionar apos a linha
`caixa_id: doc.caixa_id || null,`:

```javascript
    custo_total: doc.custo_total || 0,
    receita_com_custo: doc.receita_com_custo || 0,
    receita_base: doc.receita_base || 0,
```

`normalize()` hoje so e usado por `findByCaixa`/`findByPedido` — o CMV le via
`list()`, que devolve o documento cru. A mudanca e preventiva: sem ela, qualquer
consumo futuro dessas duas consultas veria os campos sumirem em silencio.

- [ ] **Step 4: Verificar sintaxe**

Run: `node --check lib/repositories/mongo/transacaoRepository.js`
Expected: sem saida (sucesso)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0020_custo.sql packages/domain/src/index.ts lib/repositories/mongo/transacaoRepository.js
git commit -m "schema: custo em produtos e apuracao congelada em transacoes"
```

---

### Task 2: Modulo puro de calculo

**Files:**
- Create: `lib/custo.js`
- Create: `test_custo_calculo.mjs`

**Interfaces:**
- Consumes: nada
- Produces:
  - `computeCustoVenda({ itens, custoPorProduto, rateio })` → `{ custo_total, receita_com_custo, receita_base }`
  - `computeCMV(transacoes)` → `{ custo_total, receita_com_custo, receita_base, cmv_percent, cobertura_percent, lucro_bruto }`

Este modulo existe para que a formula viva em **um lugar so**: o Dashboard e o
Relatorio precisam exatamente do mesmo numero, e os tres pontos de venda precisam
exatamente da mesma apuracao.

- [ ] **Step 1: Escrever os testes que falham**

Criar `test_custo_calculo.mjs` na raiz do projeto:

```javascript
import assert from 'node:assert/strict'
import { computeCustoVenda, computeCMV } from './lib/custo.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('produto sem custo fica fora do calculo mas entra na base', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'a', preco: 30, quantidade: 1 }],
    custoPorProduto: { a: null },
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 0)
  assert.equal(r.receita_base, 30)
})

teste('custo zero e custo real e ENTRA no calculo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'brinde', preco: 12, quantidade: 1 }],
    custoPorProduto: { brinde: 0 },
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 12) // coberto, ao contrario do teste anterior
  assert.equal(r.receita_base, 12)
})

teste('mistura coberto e nao-coberto (exemplo da spec §6.1)', () => {
  const r = computeCustoVenda({
    itens: [
      { produto_id: 'a', preco: 20, quantidade: 1 },
      { produto_id: 'b', preco: 30, quantidade: 1 },
      { produto_id: 'c', preco: 10, quantidade: 1 },
    ],
    custoPorProduto: { a: 8, b: null, c: 4 },
  })
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_com_custo, 30)
  assert.equal(r.receita_base, 60)
})

teste('quantidade multiplica preco e custo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'a', preco: 10, quantidade: 3 }],
    custoPorProduto: { a: 4 },
  })
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_base, 30)
})

teste('rateio de comanda dividida soma exatamente o total', () => {
  const itens = [{ produto_id: 'a', preco: 100, quantidade: 1 }]
  const custoPorProduto = { a: 40 }
  // subtotal itens 100, taxa de servico 10%, total 110, pago 60 + 50
  const r1 = computeCustoVenda({ itens, custoPorProduto, rateio: 60 / 110 })
  const r2 = computeCustoVenda({ itens, custoPorProduto, rateio: 50 / 110 })
  assert.equal(r1.custo_total + r2.custo_total, 40)
  assert.equal(r1.receita_base + r2.receita_base, 100)
})

teste('item avulso sem produto_id fica fora do custo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: null, preco: 25, quantidade: 1 }],
    custoPorProduto: {},
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 0)
  assert.equal(r.receita_base, 25)
})

teste('rateio invalido nao produz NaN', () => {
  const itens = [{ produto_id: 'a', preco: 50, quantidade: 1 }]
  const custoPorProduto = { a: 20 }
  for (const rateio of [NaN, Infinity, undefined]) {
    const r = computeCustoVenda({ itens, custoPorProduto, rateio })
    assert.ok(Number.isFinite(r.custo_total), `custo_total nao finito para rateio ${rateio}`)
    assert.ok(Number.isFinite(r.receita_base), `receita_base nao finito para rateio ${rateio}`)
  }
})

teste('centavos nao acumulam erro de ponto flutuante', () => {
  const r = computeCustoVenda({
    itens: [
      { produto_id: 'a', preco: 0.1, quantidade: 1 },
      { produto_id: 'b', preco: 0.2, quantidade: 1 },
    ],
    custoPorProduto: { a: 0.05, b: 0.1 },
  })
  assert.equal(r.receita_base, 0.3)
  assert.equal(r.custo_total, 0.15)
})

teste('computeCMV agrega e calcula os tres indicadores', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 8, receita_com_custo: 20, receita_base: 50 },
    { tipo: 'receita', custo_total: 4, receita_com_custo: 10, receita_base: 10 },
  ])
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_com_custo, 30)
  assert.equal(r.receita_base, 60)
  assert.equal(r.cmv_percent, 40)
  assert.equal(r.cobertura_percent, 50)
  assert.equal(r.lucro_bruto, 18)
})

teste('computeCMV ignora despesa — estorno nao devolve custo', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 10, receita_com_custo: 40, receita_base: 40 },
    { tipo: 'despesa', categoria: 'Estorno', custo_total: 99, receita_com_custo: 99, receita_base: 99 },
  ])
  assert.equal(r.custo_total, 10)
  assert.equal(r.receita_com_custo, 40)
})

teste('indicadores sao null, nao zero, quando nao ha base', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 0, receita_com_custo: 0, receita_base: 80 },
  ])
  assert.equal(r.cmv_percent, null)
  assert.equal(r.lucro_bruto, null)
  assert.equal(r.cobertura_percent, 0) // ha base, cobertura e zero de verdade
})

teste('CMV acima de 100% quando o custo supera o preco', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 15, receita_com_custo: 10, receita_base: 10 },
  ])
  assert.equal(r.cmv_percent, 150)
  assert.equal(r.lucro_bruto, -5)
})

console.log(`\n${passou} testes passaram`)
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node test_custo_calculo.mjs`
Expected: FAIL — `Cannot find module './lib/custo.js'`

- [ ] **Step 3: Implementar o modulo**

Criar `lib/custo.js`:

```javascript
/**
 * Custo de mercadoria vendida (CMV) e margem.
 *
 * Modulo puro: nao toca banco, nao toca HTTP. Existe separado para que a
 * formula viva em um lugar so — os tres pontos de venda apuram com a mesma
 * regra, e o Dashboard e o Relatorio agregam com a mesma regra.
 *
 * Produto sem custo cadastrado (`null`) NAO entra na conta. Produto com custo
 * `0` entra. Essa distincao e o que permite reportar cobertura em vez de um
 * CMV falsamente baixo.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Apura o custo de uma venda a partir dos itens e do custo cadastrado de cada
 * produto.
 *
 * `receita_base` e o subtotal dos itens (`preco * quantidade`). Desconto,
 * acrescimo e taxa de entrega ficam de fora de proposito: CMV compara custo de
 * mercadoria com receita de mercadoria — taxa de entrega e receita de servico e
 * desconto e ajuste comercial. Misturar distorceria o indicador.
 *
 * @param {object} p
 * @param {Array<{produto_id: string|null, preco: number, quantidade: number}>} p.itens
 * @param {Object<string, number|null>} p.custoPorProduto mapa produto_id -> custo
 * @param {number} p.rateio fracao desta transacao sobre o total da venda.
 *   Comanda paga em dois metodos gera duas transacoes; cada uma leva sua fatia,
 *   e a soma dos rateios e 1, entao qualquer soma dos campos continua exata.
 * @returns {{custo_total: number, receita_com_custo: number, receita_base: number}}
 */
export function computeCustoVenda({ itens, custoPorProduto, rateio = 1 }) {
  const lista = itens || []
  const custos = custoPorProduto || {}
  // Divisao por zero no chamador (comanda de total zero) viraria Infinity ou
  // NaN e contaminaria o banco. Aqui vira 0.
  const fracao = Number.isFinite(Number(rateio)) ? Number(rateio) : 0

  let custo_total = 0
  let receita_com_custo = 0
  let receita_base = 0

  for (const item of lista) {
    const quantidade = Number(item.quantidade || 0)
    const linha = Number(item.preco || 0) * quantidade
    receita_base += linha

    if (!item.produto_id) continue

    const custo = custos[item.produto_id]
    // `null`/`undefined` = nao cadastrado, fica fora. `0` = custo zero real,
    // entra. Nao trocar por `if (!custo)`, que descartaria o zero.
    if (custo === null || custo === undefined) continue

    custo_total += Number(custo) * quantidade
    receita_com_custo += linha
  }

  return {
    custo_total: round2(custo_total * fracao),
    receita_com_custo: round2(receita_com_custo * fracao),
    receita_base: round2(receita_base * fracao),
  }
}

/**
 * Agrega transacoes ja gravadas em indicadores de gestao.
 *
 * So `tipo === 'receita'` entra: estorno e despesa e nao devolve custo — a
 * comida foi produzida e perdida, o custo aconteceu de verdade. Efeito pratico:
 * estorno piora o CMV, que e o sinal correto.
 *
 * @param {Array<{tipo: string, custo_total: number, receita_com_custo: number, receita_base: number}>} transacoes
 */
export function computeCMV(transacoes) {
  const receitas = (transacoes || []).filter((t) => t.tipo === 'receita')
  const soma = (campo) => round2(receitas.reduce((s, t) => s + Number(t[campo] || 0), 0))

  const custo_total = soma('custo_total')
  const receita_com_custo = soma('receita_com_custo')
  const receita_base = soma('receita_base')

  // `null`, nunca `0`: "nao da para saber" e diferente de "e zero", e a UI
  // precisa distinguir para mostrar o estado vazio certo no primeiro dia de uso.
  const cmv_percent = receita_com_custo > 0
    ? round2((custo_total / receita_com_custo) * 100)
    : null
  const lucro_bruto = receita_com_custo > 0
    ? round2(receita_com_custo - custo_total)
    : null
  const cobertura_percent = receita_base > 0
    ? round2((receita_com_custo / receita_base) * 100)
    : null

  return {
    custo_total,
    receita_com_custo,
    receita_base,
    cmv_percent,
    cobertura_percent,
    lucro_bruto,
  }
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node test_custo_calculo.mjs`
Expected: `12 testes passaram`, saida limpa, exit code 0

- [ ] **Step 5: Commit**

```bash
git add lib/custo.js test_custo_calculo.mjs
git commit -m "feat: modulo puro de apuracao de custo e CMV"
```

---

### Task 3: Gravar o custo nos tres pontos de venda

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `computeCustoVenda({ itens, custoPorProduto, rateio })` de `lib/custo.js`
- Produces: helper `mapaCustoProdutos(repos, ctx, itens)` → `Promise<Object<string, number|null>>`; toda transacao de receita nasce com `custo_total`, `receita_com_custo` e `receita_base` preenchidos

- [ ] **Step 1: Importar o modulo**

No topo de `route.js`, junto do import ja existente de `lib/caixa`:

```javascript
import { computeCustoVenda, computeCMV } from '@/lib/custo'
```

Confira como `import { computeCaixaEsperado } from '@/lib/caixa'` esta escrito e
use exatamente a mesma forma.

- [ ] **Step 2: Criar o helper de leitura de custo**

Adicionar junto das outras funcoes auxiliares do arquivo, **fora** do handler
(perto de `resumoDoCaixa`, que segue o mesmo padrao):

```javascript
/**
 * Monta o mapa `produto_id -> custo` para os itens de uma venda.
 *
 * Uma leitura de produtos por venda (nao uma por item): a lista inteira sai em
 * uma query e o filtro acontece em memoria, no mesmo espirito do que a baixa de
 * estoque ja faz logo abaixo de cada ponto de venda.
 *
 * Falha de leitura NAO derruba a venda: devolve mapa vazio, o que faz a
 * apuracao gravar `custo_total = 0` e `receita_com_custo = 0` mantendo
 * `receita_base` real. O efeito e a cobertura cair, que e exatamente o sinal
 * honesto — "esta venda nao teve custo apurado" — em vez de um numero inventado.
 */
async function mapaCustoProdutos(repos, ctx, itens) {
  try {
    const ids = [...new Set((itens || []).map((i) => i.produto_id).filter(Boolean))]
    if (ids.length === 0) return {}
    const todos = await repos.produtoRepo.list(ctx.empresa_id)
    const mapa = {}
    for (const p of todos) {
      if (ids.includes(p.id)) mapa[p.id] = p.custo ?? null
    }
    return mapa
  } catch (e) {
    console.warn(`Apuracao de custo falhou: ${e.message}`)
    await audit(repos, ctx, 'custo_erro', 'produto', null, { erro: e.message })
    return {}
  }
}
```

- [ ] **Step 3: Gravar no pedido concluido**

Localize a criacao de transacao ao concluir pedido (procure por
`descricao: \`Pedido #${pedido.numero}\``, dentro do bloco
`if (finais.includes(b.status) && !finais.includes(pedido.status))`).

Os itens vem de `upd.itens` quando a mesma requisicao alterou os itens, e de
`pedido.itens` caso contrario — o mesmo criterio que a linha `totalFinal` logo
acima ja usa para o total. Antes do `transacaoRepo.create`:

```javascript
        const itensVendidos = upd.itens !== undefined ? upd.itens : (pedido.itens || [])
        const custoMapa = await mapaCustoProdutos(repos, ctx, itensVendidos)
        const custo = computeCustoVenda({ itens: itensVendidos, custoPorProduto: custoMapa })
```

E acrescentar os tres campos ao objeto passado para `transacaoRepo.create`, logo
apos `caixa_id`:

```javascript
          custo_total: custo.custo_total,
          receita_com_custo: custo.receita_com_custo,
          receita_base: custo.receita_base,
```

- [ ] **Step 4: Gravar na comanda fechada com pagamentos**

Localize o bloco `if (pagamentos.length > 0) {` dentro de
`POST /comandas/:id/fechar`. O mapa e lido **uma vez, fora do laco** — ler
dentro faria uma query por metodo de pagamento.

Antes do `if (pagamentos.length > 0) {`:

```javascript
      const custoMapa = await mapaCustoProdutos(repos, ctx, comanda.itens)
```

Dentro do laco `for (const pg of pagamentos) {`, antes do `transacaoRepo.create`:

```javascript
          // Rateio: que fatia desta venda esta transacao representa. A soma dos
          // rateios e 1, entao a soma dos campos de custo fecha com o total.
          const rateio = totals.total > 0 ? pg.valor / totals.total : 0
          const custo = computeCustoVenda({ itens: comanda.itens, custoPorProduto: custoMapa, rateio })
```

E os tres campos no objeto do `create`, apos `caixa_id`:

```javascript
            custo_total: custo.custo_total,
            receita_com_custo: custo.receita_com_custo,
            receita_base: custo.receita_base,
```

- [ ] **Step 5: Gravar na comanda fechada sem pagamento**

No `else` do mesmo bloco (comanda fechada sem registro de pagamento), antes do
`transacaoRepo.create`:

```javascript
        const custoUnico = computeCustoVenda({ itens: comanda.itens, custoPorProduto: custoMapa })
```

E os tres campos no objeto do `create`, apos `caixa_id`:

```javascript
          custo_total: custoUnico.custo_total,
          receita_com_custo: custoUnico.receita_com_custo,
          receita_base: custoUnico.receita_base,
```

`custoMapa` ja esta em escopo — foi lido no Step 4, antes do `if/else`.

- [ ] **Step 6: Confirmar que o estorno NAO recebe custo**

Localize `POST /pedidos/:id/estorno` (procure por `categoria: 'Estorno'`).
**Nao alterar.** Os tres campos ficam no `default 0` do banco, que e o
comportamento correto: a comida foi produzida e perdida, o custo aconteceu.

Este step e uma verificacao, nao uma edicao — confirme que nenhum campo de custo
foi adicionado ali por engano.

- [ ] **Step 7: Verificar sintaxe**

Run: `node --check "app/api/[[...path]]/route.js"`
Expected: sem saida (sucesso)

- [ ] **Step 8: Commit**

```bash
git add "app/api/[[...path]]/route.js"
git commit -m "feat: apura e congela o custo nos tres pontos de venda"
```

---

### Task 4: Expor CMV no Dashboard e no Relatorio

**Files:**
- Modify: `app/api/[[...path]]/route.js`

**Interfaces:**
- Consumes: `computeCMV(transacoes)` de `lib/custo.js` (importado na Task 3)
- Produces: bloco `cmv` no retorno de `GET /dashboard/metrics` e de `GET /financeiro/relatorio`, ambos com a forma `{ custo_total, receita_com_custo, receita_base, cmv_percent, cobertura_percent, lucro_bruto }`

- [ ] **Step 1: Adicionar o bloco no Dashboard**

Em `GET /dashboard/metrics` (procure por `route === '/dashboard/metrics'`), a
variavel `transacoes` ja esta carregada e `today` ja esta definido. Antes do
`return json({...})`:

```javascript
      // Mesmo recorte de `receitaHoje`: so o que entrou hoje.
      const cmv = computeCMV(transacoes.filter((t) => new Date(t.data) >= today))
```

E acrescentar `cmv` ao objeto retornado, junto de `serie, topProdutos, recentes, porStatus`:

```javascript
        serie, topProdutos, recentes, porStatus, cmv,
```

- [ ] **Step 2: Adicionar o bloco no Relatorio**

Em `GET /financeiro/relatorio` (procure por `route === '/financeiro/relatorio'`),
a variavel `trans` ja contem as transacoes filtradas pelo periodo. Apos a linha
que calcula `despesas`:

```javascript
      // `trans` ja veio filtrado pelo periodo da tela.
      const cmv = computeCMV(trans)
```

E acrescentar `cmv` ao objeto do `return json({...})` desse endpoint, no mesmo
nivel de `kpis`. Confira como o retorno esta montado e adicione `cmv,` a lista.

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check "app/api/[[...path]]/route.js"`
Expected: sem saida (sucesso)

- [ ] **Step 4: Verificar no navegador**

Suba o ambiente local. Chame `GET /api/dashboard/metrics` numa empresa sem custo
cadastrado e confirme `cmv.cmv_percent = null` e `cmv.cobertura_percent = 0` (ha
receita, nenhuma coberta). Cadastre custo num produto, conclua um pedido com ele,
chame de novo e confirme `cmv_percent` e `lucro_bruto` preenchidos.

- [ ] **Step 5: Commit**

```bash
git add "app/api/[[...path]]/route.js"
git commit -m "feat: bloco cmv no dashboard e no relatorio financeiro"
```

---

### Task 5: UI — campo de custo no cadastro do produto

**Files:**
- Modify: `app/page.js:519-527` (componente `ProdutoDialog`)

**Interfaces:**
- Consumes: coluna `produtos.custo` da Task 1
- Produces: campo `custo` no formulario; grava `null` quando vazio

Este e o unico ponto de entrada do dado — sem ele o resto da feature nao tem
como funcionar.

- [ ] **Step 1: Adicionar o campo ao formulario**

Em `ProdutoDialog`, o preco e a categoria vivem hoje num `grid grid-cols-2`.
Trocar esse grid por tres colunas e inserir o custo entre eles. Substituir:

```jsx
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label>Preço (R$)</Label><Input type="number" step="0.01" value={f.preco} onChange={(e) => set('preco', e.target.value)} /></div>
```

por:

```jsx
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-2"><Label>Preço (R$)</Label><Input type="number" step="0.01" value={f.preco} onChange={(e) => set('preco', e.target.value)} /></div>
            <div className="space-y-2">
              <Label>Custo (R$)</Label>
              <Input type="number" min="0" step="0.01" placeholder="opcional"
                value={f.custo ?? ''} onChange={(e) => set('custo', e.target.value)} />
            </div>
```

O `?? ''` importa: `custo` vem `null` do banco, e `value={null}` faz o React
tratar o input como nao-controlado e emitir warning.

- [ ] **Step 2: Adicionar a linha de ajuda**

Logo abaixo do fechamento desse grid (apos o `</div>` que fecha o
`grid grid-cols-2 gap-3 sm:grid-cols-3`), inserir:

```jsx
          <p className="-mt-2 text-xs text-muted-foreground">
            Custo é quanto você paga para produzir. Deixe vazio se ainda não souber —
            o produto fica de fora do cálculo de CMV até ser preenchido.
          </p>
```

- [ ] **Step 3: Converter vazio em `null` ao salvar**

Localize onde o dialog envia o formulario (o `onSave(f)` do `ProdutoDialog`, ou o
handler que recebe esse `f` e chama a API). O campo chega como **string** do
input. Converter imediatamente antes do envio:

```javascript
    const payload = {
      ...f,
      custo: f.custo === '' || f.custo === null || f.custo === undefined
        ? null
        : Number(f.custo),
    }
```

e enviar `payload` no lugar de `f`.

String vazia precisa virar `null`, nao `0`: `Number('')` e `0`, e gravar zero
diria "este produto custa nada" em vez de "ainda nao sei o custo" — exatamente a
mentira que a feature existe para evitar.

- [ ] **Step 4: Verificar no navegador**

Abra o cadastro de um produto, deixe o custo vazio e salve; confirme via
`GET /api/produtos` que o campo veio `null`. Edite o mesmo produto, preencha
`0` e salve; confirme que agora veio `0`, nao `null` — a distincao entre "sem
custo" e "custo zero" precisa sobreviver ao formulario.

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat: campo de custo no cadastro do produto"
```

---

### Task 6: UI — cards de CMV no Dashboard

**Files:**
- Modify: `app/page.js:339-352` (componente `Dashboard`)

**Interfaces:**
- Consumes: `m.cmv` de `GET /dashboard/metrics` (Task 4)
- Produces: componente `CmvCards({ cmv })`

- [ ] **Step 1: Criar o componente**

Adicionar logo antes de `function Dashboard()`:

```jsx
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
```

- [ ] **Step 2: Montar no Dashboard**

Em `function Dashboard()`, inserir entre o grid de `Stat` e o `<EstoqueBaixoCard />`:

```jsx
      <CmvCards cmv={m.cmv} />
```

- [ ] **Step 3: Verificar no navegador**

Abra o Dashboard numa empresa sem nenhum custo cadastrado e confirme o card
tracejado com a mensagem, nao um `—` nem `NaN%`. Cadastre custo em um produto,
conclua um pedido com ele e outro sem, recarregue: confirme o CMV preenchido e a
cobertura abaixo de 100% em amarelo ou vermelho.

- [ ] **Step 4: Commit**

```bash
git add app/page.js
git commit -m "feat: cards de lucro bruto e CMV no dashboard"
```

---

### Task 7: UI — CMV no Relatorio financeiro e no CSV

**Files:**
- Modify: `app/page.js:1709-1715` (funcao `exportCsv`)
- Modify: `app/page.js:1740-1750` (grids de `Stat` do componente `Relatorios`)

**Interfaces:**
- Consumes: `rep.cmv` de `GET /financeiro/relatorio` (Task 4)
- Produces: terceira linha de KPIs e tres linhas novas no CSV

- [ ] **Step 1: Adicionar a linha de KPIs**

Em `Relatorios`, apos o segundo `<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">`
(o que contem Receitas/Despesas/Recebidos), inserir:

```jsx
          {rep.cmv && rep.cmv.cmv_percent !== null && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat icon={TrendingUp} label="Lucro bruto" value={brl(rep.cmv.lucro_bruto)} tone="emerald" />
              <Stat icon={TrendingDown} label="Custo da mercadoria" value={brl(rep.cmv.custo_total)} tone="amber" />
              <Stat icon={DollarSign} label="CMV" value={`${rep.cmv.cmv_percent.toFixed(1).replace('.', ',')}%`} hint="referência do setor: 28–35%" tone="violet" />
              <Stat icon={CheckCircle2} label="Cobertura de custo" value={`${(rep.cmv.cobertura_percent ?? 0).toFixed(0)}%`} hint="quanto do faturamento tem custo apurado" tone="primary" />
            </div>
          )}
```

A linha inteira some quando nao ha custo apurado no periodo — um bloco de
zeros passaria por informacao e nao e.

- [ ] **Step 2: Acrescentar as linhas ao CSV**

Em `exportCsv`, o CSV hoje tem so a tabela de pedidos. Acrescentar um bloco de
resumo antes dela. Substituir o corpo da funcao por:

```javascript
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
    rows.push(['Data', 'Pedido', 'Cliente', 'Pagamento', 'Valor', 'Status', 'Origem'])
    for (const r of rep.tabela) {
      rows.push([new Date(r.data).toLocaleString('pt-BR'), r.numero, r.cliente, r.pagamento, String(r.valor).replace('.', ','), r.status, r.origem])
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `relatorio-${Date.now()}.csv`; a.click()
  }
```

O `replace('.', ',')` e o `﻿` ja existiam e continuam: sao o que faz o Excel
brasileiro abrir o arquivo com acentos e numeros corretos.

- [ ] **Step 3: Verificar no navegador**

Abra Financeiro → Relatórios num período com vendas de produtos com custo.
Confirme a terceira linha de KPIs. Baixe o CSV e abra: confirme o bloco "Resumo
de custo" no topo, com virgula decimal. Troque para um período sem custo apurado
e confirme que a linha de KPIs e o bloco do CSV somem por inteiro.

- [ ] **Step 4: Commit**

```bash
git add app/page.js
git commit -m "feat: CMV no relatorio financeiro e no export CSV"
```

---

### Task 8: Testes de integracao

**Files:**
- Create: `backend_test_custo.py`

**Interfaces:**
- Consumes: todos os endpoints das Tasks 3 e 4
- Produces: suite executavel com `BASE_URL=http://localhost:3000/api python3 backend_test_custo.py`

- [ ] **Step 1: Escrever a suite**

Criar `backend_test_custo.py` na raiz do projeto, seguindo o padrao de
`backend_test_caixa.py`:

```python
import os
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def nova_empresa(nome):
    """Cria empresa + usuario e devolve (headers, empresa_id)."""
    r = requests.post(f"{BASE_URL}/signup", json={
        "nome": nome,
        "email": f"{nome.lower()}-{os.urandom(4).hex()}@test.com",
        "senha": "senha123",
    }).json()
    return {"Authorization": f"Bearer {r['token']}"}, r["empresa_id"]


def novo_produto(headers, nome, preco, custo):
    cat = requests.post(f"{BASE_URL}/categorias",
                        json={"nome": "Geral", "ordem": 1}, headers=headers).json()
    return requests.post(f"{BASE_URL}/produtos", json={
        "categoria_id": cat["id"], "nome": nome, "preco": preco,
        "custo": custo, "disponivel": True,
    }, headers=headers).json()


def concluir_pedido(headers, produto, quantidade=1):
    """Cria e conclui um pedido, devolvendo o pedido concluido."""
    pedido = requests.post(f"{BASE_URL}/pedidos", json={
        "tipo": "balcao", "pagamento": "dinheiro",
        "itens": [{"produto_id": produto["id"], "nome": produto["nome"],
                   "preco": produto["preco"], "quantidade": quantidade}],
    }, headers=headers).json()
    return requests.put(f"{BASE_URL}/pedidos/{pedido['id']}",
                        json={"status": "concluido"}, headers=headers).json()


def transacoes(headers):
    return requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()


def test_pedido_concluido_grava_custo():
    """Pedido de produto com custo grava os tres campos."""
    headers, _ = nova_empresa("CustoBasico")
    p = novo_produto(headers, "Hamburguer", 20.0, 8.0)
    concluir_pedido(headers, p, quantidade=2)

    vendas = [t for t in transacoes(headers) if t["tipo"] == "receita" and t["categoria"] == "Vendas"]
    assert len(vendas) == 1, f"esperava 1 venda, veio {len(vendas)}"
    t = vendas[0]
    assert float(t["custo_total"]) == 16.0, t["custo_total"]
    assert float(t["receita_com_custo"]) == 40.0, t["receita_com_custo"]
    assert float(t["receita_base"]) == 40.0, t["receita_base"]


def test_produto_sem_custo_fica_fora():
    """Produto com custo nulo entra so em receita_base."""
    headers, _ = nova_empresa("SemCusto")
    p = novo_produto(headers, "Agua", 5.0, None)
    concluir_pedido(headers, p)

    t = [x for x in transacoes(headers) if x["tipo"] == "receita"][0]
    assert float(t["custo_total"]) == 0.0
    assert float(t["receita_com_custo"]) == 0.0
    assert float(t["receita_base"]) == 5.0


def test_custo_zero_entra_no_calculo():
    """Custo zero e coberto — diferente de custo nao cadastrado."""
    headers, _ = nova_empresa("CustoZero")
    p = novo_produto(headers, "Brinde", 10.0, 0)
    concluir_pedido(headers, p)

    t = [x for x in transacoes(headers) if x["tipo"] == "receita"][0]
    assert float(t["custo_total"]) == 0.0
    assert float(t["receita_com_custo"]) == 10.0, "custo 0 deve ser coberto"


def test_comanda_dividida_rateia_o_custo():
    """Comanda paga em dois metodos: a soma dos custos bate com o total."""
    headers, _ = nova_empresa("Dividida")
    p = novo_produto(headers, "Pizza", 100.0, 40.0)

    mesa = requests.post(f"{BASE_URL}/mesas", json={"numero": 1}, headers=headers).json()
    comanda = requests.post(f"{BASE_URL}/comandas",
                            json={"mesa_id": mesa["id"], "pessoas": 2}, headers=headers).json()
    requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", json={
        "produto_id": p["id"], "nome": p["nome"], "preco": p["preco"], "quantidade": 1,
    }, headers=headers)
    # zera a taxa de servico para o total ser exatamente o subtotal
    requests.put(f"{BASE_URL}/comandas/{comanda['id']}",
                 json={"taxa_servico_percent": 0}, headers=headers)
    for metodo, valor in [("dinheiro", 60.0), ("cartao", 40.0)]:
        requests.post(f"{BASE_URL}/comandas/{comanda['id']}/pagamentos",
                      json={"metodo": metodo, "valor": valor}, headers=headers)
    requests.post(f"{BASE_URL}/comandas/{comanda['id']}/fechar", json={}, headers=headers)

    vendas = [t for t in transacoes(headers) if t["tipo"] == "receita" and t["categoria"] == "Vendas"]
    assert len(vendas) == 2, f"esperava 2 transacoes, veio {len(vendas)}"
    assert abs(sum(float(t["custo_total"]) for t in vendas) - 40.0) < 0.02
    assert abs(sum(float(t["receita_base"]) for t in vendas) - 100.0) < 0.02


def test_estorno_nao_devolve_custo():
    """Estorno e despesa e nao carrega custo."""
    headers, _ = nova_empresa("Estorno")
    p = novo_produto(headers, "Prato", 50.0, 20.0)
    pedido = concluir_pedido(headers, p)

    requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno",
                  json={"valor": 50.0, "motivo": "cliente desistiu"}, headers=headers)

    estornos = [t for t in transacoes(headers) if t["categoria"] == "Estorno"]
    assert len(estornos) == 1
    assert float(estornos[0]["custo_total"]) == 0.0
    assert float(estornos[0]["receita_com_custo"]) == 0.0


def test_dashboard_expoe_cmv():
    """Dashboard devolve o bloco cmv com os indicadores calculados."""
    headers, _ = nova_empresa("DashCmv")
    com_custo = novo_produto(headers, "Com custo", 20.0, 8.0)
    concluir_pedido(headers, com_custo)

    cmv = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers).json()["cmv"]
    assert float(cmv["custo_total"]) == 8.0
    assert float(cmv["receita_com_custo"]) == 20.0
    assert abs(float(cmv["cmv_percent"]) - 40.0) < 0.1
    assert float(cmv["lucro_bruto"]) == 12.0


def test_cmv_nulo_quando_nada_tem_custo():
    """Sem nenhum custo cadastrado, os indicadores sao null e nao zero."""
    headers, _ = nova_empresa("CmvNulo")
    p = novo_produto(headers, "Sem custo", 30.0, None)
    concluir_pedido(headers, p)

    cmv = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers).json()["cmv"]
    assert cmv["cmv_percent"] is None, "deve ser null, nao 0"
    assert cmv["lucro_bruto"] is None, "deve ser null, nao 0"
    assert float(cmv["cobertura_percent"]) == 0.0, "ha base, cobertura e zero real"


def test_relatorio_expoe_cmv():
    """Relatorio financeiro devolve o bloco cmv no periodo."""
    headers, _ = nova_empresa("RelCmv")
    p = novo_produto(headers, "Item", 40.0, 10.0)
    concluir_pedido(headers, p)

    cmv = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers).json()["cmv"]
    assert float(cmv["custo_total"]) == 10.0
    assert abs(float(cmv["cmv_percent"]) - 25.0) < 0.1


def test_isolamento_multi_tenant():
    """Empresa A nao ve o custo da empresa B."""
    ha, _ = nova_empresa("TenantA")
    hb, _ = nova_empresa("TenantB")
    concluir_pedido(ha, novo_produto(ha, "ProdutoA", 100.0, 50.0))
    concluir_pedido(hb, novo_produto(hb, "ProdutoB", 10.0, 1.0))

    a = requests.get(f"{BASE_URL}/dashboard/metrics", headers=ha).json()["cmv"]
    b = requests.get(f"{BASE_URL}/dashboard/metrics", headers=hb).json()["cmv"]
    assert float(a["custo_total"]) == 50.0
    assert float(b["custo_total"]) == 1.0


if __name__ == "__main__":
    testes = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    falhas = 0
    for t in testes:
        try:
            t()
            print(f"PASS: {t.__name__}")
        except Exception as e:
            falhas += 1
            print(f"FAIL: {t.__name__}\n   {e}")
    print(f"\n{len(testes) - falhas}/{len(testes)} testes passaram")
    raise SystemExit(1 if falhas else 0)
```

- [ ] **Step 2: Rodar contra o servidor local**

Com o servidor local rodando:

Run: `BASE_URL=http://localhost:3000/api python3 backend_test_custo.py`
Expected: `9/9 testes passaram`

Se algum teste falhar por diferenca de nome de endpoint (ex.: a rota de
pagamentos de comanda), corrija o **teste** para o endpoint real — confira em
`backend_test_caixa.py`, que ja exercita esses mesmos fluxos.

- [ ] **Step 3: Commit**

```bash
git add backend_test_custo.py
git commit -m "test: suite de integracao de custo e CMV"
```

---

### Task 9: Verificacao final

**Files:**
- Nenhum arquivo novo; esta task valida o conjunto

**Interfaces:**
- Consumes: tudo das Tasks 1-8
- Produces: confirmacao de que a feature esta pronta para deploy

- [ ] **Step 1: Rodar os testes puros**

Run: `node test_custo_calculo.mjs`
Expected: `12 testes passaram`, exit code 0

- [ ] **Step 2: Rodar o build de producao**

Run: `npm run build`
Expected: `✓ Compiled successfully`, sem erro de tipo ou de lint

- [ ] **Step 3: Verificar sintaxe dos arquivos grandes**

```bash
node --check "app/api/[[...path]]/route.js"
node --check app/page.js
node --check lib/custo.js
```
Expected: sem saida em nenhum dos tres

- [ ] **Step 4: Conferir que a migration esta na sequencia**

Run: `ls supabase/migrations/ | tail -3`
Expected: `0018_caixa.sql`, `0019_estoque.sql`, `0020_custo.sql` — nesta ordem,
sem numero duplicado

- [ ] **Step 5: Percorrer o fluxo completo no navegador**

1. Cadastrar dois produtos: um com custo, um sem
2. Concluir um pedido com cada
3. Dashboard: confirmar lucro bruto, CMV e cobertura abaixo de 100%
4. Financeiro → Relatórios: confirmar a linha de KPIs e baixar o CSV
5. Fechar uma comanda com dois métodos de pagamento e confirmar que o CMV do
   Dashboard nao pulou nem duplicou

- [ ] **Step 6: Confirmar que nao ha alteracao nao commitada**

Run: `git status --short`
Expected: saida vazia

- [ ] **Step 7: Commit da documentacao**

Atualizar `HANDOFF.md`: mover Custo/CMV de "em andamento" (§0) para a lista de
modulos concluidos, com os commits das Tasks 1-8, e promover **Ficha tecnica
(insumos)** ao topo do roadmap — e o proximo passo natural, e agora
`produtos.custo` existe para ela derivar.

```bash
git add HANDOFF.md
git commit -m "docs: Custo e Margem (CMV) completo — 9/9 tasks"
```

---

## Auto-revisao do plano

**Cobertura da spec** — cada secao tem task:

| Spec | Task |
|---|---|
| §5.1 migration | 1 |
| §5.2 contratos de dominio | 1 |
| §6 modulo puro + `null` vs `0` + `receita_base` | 2 |
| §6.1 exemplo verificado | 2 (teste 3) |
| §7 tres pontos de integracao + rateio | 3 |
| §4.4 estorno sem custo | 3 (Step 6) + 2 (teste 10) + 8 (teste 5) |
| §4.5 falha nao derruba a venda | 3 (Step 2) |
| §8.1 Dashboard | 4 + 6 |
| §8.2 Relatorio + CSV | 4 + 7 |
| §8.3 campo no cadastro | 5 |
| §9 bordas | 2 (testes) + 6 (estado vazio) |
| §10.1 testes puros | 2 |
| §10.2 testes de integracao | 8 |

**Duas correcoes feitas na spec durante a escrita deste plano**, ambas por
leitura do codigo real — a spec ja esta atualizada, nao ha divergencia pendente:

1. **§11 listava mudanca em 4 repositorios; o real e 1.** Produto e transacao
   propagam campos novos automaticamente nos dois backends (`insert(entity)` /
   `insertOne(entity)`, `update(patch)` / `$set: patch`, `select('*')`). So o
   `normalize()` do `mongo/transacaoRepository.js` monta campo a campo.
2. **§4.5 dizia "tres campos zerados" na falha de leitura; agora mantem
   `receita_base` real.** Zerar os tres tiraria a venda tambem do denominador da
   cobertura, fazendo a cobertura parecer melhor do que e justamente quando a
   apuracao falhou. Manter a base e zerar custo/coberto faz a cobertura cair,
   que e o sinal honesto.

**Consistencia de tipos:** `computeCustoVenda` e `computeCMV` sao usados nas
Tasks 3 e 4 exatamente com as assinaturas definidas na Task 2. O objeto `cmv`
produzido na Task 4 e consumido com os mesmos nomes de campo nas Tasks 6 e 7
(`cmv_percent`, `cobertura_percent`, `lucro_bruto`, `custo_total`,
`receita_com_custo`). O campo `custo` do formulario (Task 5) e o mesmo lido pelo
`mapaCustoProdutos` (Task 3).

**Sem placeholders:** todo step de codigo traz o codigo real; nenhum "TBD",
"similar a Task N" ou "adicione tratamento de erro".
