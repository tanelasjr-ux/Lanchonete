# Auditoria — Fase 6 (Migração de Dados MongoDB → Supabase)

Auditoria obrigatória antes de codificar a ferramenta de migração. Reconfirma
(não reabre do zero — já verificado linha a linha nesta mesma sessão, nas
Fases 1, 3, 4 e 5) contra `docs/plans/MONGO-TO-SUPABASE-AUDIT.md`,
`docs/plans/PHASE-4-SUPABASE-SCHEMA.md`, `docs/plans/PHASE-5-SUPABASE-REPOSITORIES.md`,
`packages/domain/src/index.ts`, os 14 `Mongo*Repository`, os 15
`Supabase*Repository`, `app/api/[[...path]]/route.js` (incluindo
`seedEmpresa()`) e `test_result.md`. Nenhuma migração de dado real foi
executada para produzir este documento.

**Princípio-guia (reforçado explicitamente pelo usuário nesta fase):** migrar
com base no **MongoDB real**, não no que `domain.ts` diz que deveria existir.
As diferenças já documentadas (itens sem `id`/`desconto`/`subtotal`,
`comanda.pagamentos[]` duplicado) são tratadas explicitamente abaixo, nunca
inventando dado para preencher a lacuna.

---

## 1. Mapeamento completo (Mongo → Supabase)

| # | Coleção Mongo | Tabela Supabase | Transformação | Dependências (FK) | Estratégia de ID | Estratégia de conflito | Validação |
|---|---|---|---|---|---|---|---|
| 1 | `empresas` | `empresas` | Direta (schema já tem os 6 campos da Fase 4) | — (raiz) | Preserva `id` do Mongo | `upsert(id)` | Contagem + `slug` único |
| 2 | `usuarios` | `usuarios` | Direta; `senha_hash` já existe (Fase 4) | `empresa_id` | Preserva `id` | `upsert(id)` | Contagem por empresa + `email` único global |
| 3 | `categorias` | `categorias` | Direta | `empresa_id` | Preserva `id` | `upsert(id)` | Contagem por empresa |
| 4 | `produtos` | `produtos` | Direta | `empresa_id`, `categoria_id` (nullable) | Preserva `id` | `upsert(id)` | Contagem + órfãos de `categoria_id` |
| 5 | `clientes` | `clientes` | Direta | `empresa_id` | Preserva `id` | `upsert(id)` | Contagem + soma `total_gasto` |
| 6 | `mesas` | `mesas` | Direta | `empresa_id`; `comanda_id` (nullable, ver ordem §2) | Preserva `id` | `upsert(id)` | Contagem por empresa |
| 7 | `pedidos` + itens embutidos | `pedidos` + `pedido_itens` | **Split** (ver §4) — itens embutidos viram linhas filhas; sintetiza `id`/`desconto`/`subtotal`/`observacao` ausentes (ver §4); preserva `comanda_id` (ver §3.1) | `empresa_id`, `cliente_id` (nullable), `comanda_id` (nullable, só para pedidos originados de fechamento de comanda) | Preserva `id` do pedido; itens preservam `id` quando existir, senão gera novo (documentado) | RPC `upsert_pedido_com_itens` (atômica: upsert pai + replace filhos) | Contagem pedidos + itens, soma `total`; para pedidos com `comanda_id`, checar que a comanda referenciada foi migrada |
| 8 | `comandas` + itens embutidos + `pagamentos[]` embutido | `comandas` + `comanda_itens` | **Split** dos itens; **descarta** `pagamentos[]` (fonte é a tabela `pagamentos`, migrada separadamente, ver §5) | `empresa_id`, `mesa_id`, `cliente_id` (nullable) | Preserva `id`; itens idem pedido | RPC `upsert_comanda_com_itens` | Contagem comandas + itens; `pago`/`restante` recalculados batendo com a soma real de `pagamentos` |
| 9 | `pagamentos` | `pagamentos` | Direta | `empresa_id`, `comanda_id`/`pedido_id` (nullable, ao menos um obrigatório — `pagamentos_vinculo_check`) | Preserva `id` | `upsert(id)` | Contagem + soma `valor` por `status` |
| 10 | `transacoes` | `transacoes` | Direta | `empresa_id`, `pedido_id`/`comanda_id` (nullable) | Preserva `id` | `upsert(id)` | Contagem + soma `valor` por `tipo` |
| 11 | `integracoes` | `integracoes` | Direta | `empresa_id` | Preserva `id` | `upsert(id)` (chave lógica real é `empresa_id+tipo`, mas `id` já é estável na origem) | Contagem por empresa (3 por tenant: evolution/n8n/mercadopago) |
| 12 | `conversas` | `conversas` | Direta | `empresa_id`, `cliente_id`/`pedido_ativo_id` (nullable) | Preserva `id` | `upsert(id)` | Contagem + `(empresa_id,contato_numero)` único |
| 13 | `mensagens` | `mensagens` | Direta | `empresa_id`, `conversa_id` | Preserva `id` | `upsert(id)` | Contagem por conversa, ordem por `created_at` |
| 14 | `webhook_events` | `webhook_events` | Direta, mas **não migrado** (ver §6 — log técnico, sem valor retroativo) | `empresa_id` | N/A | N/A | N/A |
| 15 | `auditoria` | `auditoria` | Direta | `empresa_id` | Preserva `id` | `upsert(id)` | Contagem por empresa |
| — | (sem coleção Mongo) | `papeis`, `permissoes` | Não migra — catálogo global já populado por `supabase/seed.sql`, não tem dado por tenant | — | N/A | N/A | Presença das 5 linhas de `papeis` |

---

## 2. Ordem de migração (validada contra FKs reais, não a sugestão genérica)

A ordem sugerida no pedido já está quase certa, com 2 ajustes por causa de
dependência circular leve (`mesas.comanda_id` ⇄ `comandas.mesa_id`) e da
posição de `pagamentos` (depende de `comandas` **e** `pedidos` já existirem,
pois tem FK nullable para os dois):

```
1. empresas
2. usuarios                (depende de empresas)
3. (papeis/permissoes já seedados por seed.sql — pular)
4. categorias               (depende de empresas)
5. produtos                 (depende de categorias, empresas)
6. clientes                 (depende de empresas)
7. mesas — passo A: inserir SEM comanda_id (sempre null nesta etapa)
8. comandas + comanda_itens (depende de mesas, clientes, empresas)
9. pedidos + pedido_itens   (depende de clientes, empresas E comandas — ver nota abaixo)
10. mesas — passo B: UPDATE comanda_id agora que a comanda existe
11. pagamentos               (depende de comandas E pedidos)
12. transacoes                (depende de pedidos, comandas)
13. integracoes                (depende de empresas)
14. conversas                    (depende de clientes, pedidos [pedido_ativo_id])
15. mensagens                     (depende de conversas)
16. auditoria                      (depende de empresas — pode ir em qualquer
                                     ponto depois de empresas/usuarios, colocada
                                     por último por ser só log)
```

**Correção feita durante o teste real desta própria ferramenta (não só
lendo o SQL):** a primeira versão testada tinha `pedidos` antes de
`comandas` (ordem original deste documento). Isso funcionava quando este
documento foi escrito, mas ficou inválido depois da correção do §3.1
(`pedidos.comanda_id` virou uma FK real para `comandas`) — rodar a
migração real produziu o erro esperado e correto do Postgres:
`insert or update on table "pedidos" violates foreign key constraint
"pedidos_comanda_id_fkey"` (comanda ainda não existia). Corrigido invertendo
a ordem: `comandas` migra antes de `pedidos`. `mesas` continua precisando de
2 passadas (mesmo motivo de antes: `mesas.comanda_id` referencia uma comanda
que só existe depois do passo 8; comandas não podem vir antes de mesas
porque `comandas.mesa_id` é `not null`).

**Pós-migração, passo obrigatório (não é uma "19ª coleção", é acerto de
estado):** recalcular `pedido_contadores.ultimo_numero` = `max(numero)` por
empresa a partir dos pedidos migrados. Sem isso, o próximo pedido criado
pela aplicação depois do corte poderia colidir com um número já migrado
(a trigger `pedidos_set_numero()` só sabe o que está em
`pedido_contadores`, não escaneia `pedidos` sozinha).

---

## 3. IDs

**Preservados em 100% dos casos onde a origem já tem `id`** — que é a
esmagadora maioria dos documentos (todo documento criado via `route.js` já
tem `id: uuidv4()`). Nenhum novo ID é gerado sem necessidade.

**Exceção documentada e já esperada (não é bug novo, é achado da auditoria
original):** itens de `comanda_itens` criados pelo **seed de demonstração**
(`seedEmpresa()`, array `itensDemo`) não têm campo `id` no Mongo. Para
esses (e só para esses), a migração gera um novo `id` (`uuid v4`) — sem
isso, a linha não poderia ser inserida (`comanda_itens.id` é chave
primária `not null`). Contabilizado explicitamente no log
(`itens_id_sintetizado: N`).

Não há necessidade de mapa `Mongo ID → Postgres ID` separado porque **o ID
nunca muda** — é o mesmo valor UUID nos dois lados. O "mapa" é, na prática,
a identidade (`x → x`), com a única exceção documentada acima.

### 3.1 Achado durante esta própria auditoria: `pedidos.comanda_id` e `tipo='mesa'`

Ao re-verificar o formato **real** do documento `pedido` criado no fluxo de
fechamento de comanda (não assumindo o shape de `domain.ts`), `route.js`
(handler de fechamento de comanda) mostra:

```js
const pedido = {
  id: uuidv4(), empresa_id: ctx.empresa_id, numero, cliente_id: comanda.cliente_id,
  cliente_nome: comanda.cliente_nome, itens: (...),
  tipo: 'mesa', pagamento: (comanda.pagamentos?.[0]?.metodo) || 'dinheiro', status: 'concluido',
  observacoes: `Comanda ${comanda.mesa_nome}`, comanda_id: comanda.id, total: totals.total,
  created_at: new Date(), updated_at: new Date(),
}
```

Dois gaps reais e **novos** (não capturados pela auditoria original
`MONGO-TO-SUPABASE-AUDIT.md`, que só identificou o análogo em
`transacoes.comanda_id`, migration `0005`):

1. **`pedidos.comanda_id` não existia como coluna** em nenhuma migration
   0001–0011 — o valor seria silenciosamente descartado tanto no runtime
   (Fase 7+) quanto nesta migração de dados, perdendo a rastreabilidade
   "este pedido veio do fechamento desta comanda" para 100% dos pedidos
   `tipo='mesa'`.
2. **`pedidos_tipo_check` (0001_init.sql) só permitia `'balcao'|'delivery'|'retirada'`**
   — um `upsert_pedido_com_itens()` com `tipo: 'mesa'` (o valor real, único
   usado neste fluxo) violaria o CHECK constraint e falharia com erro em
   tempo de migração/runtime. Confirmado contra todos os pontos do código
   que atribuem `pedido.tipo` (`route.js`: seed demo usa
   `['balcao','delivery','retirada']`; criação normal usa
   `body.tipo || 'balcao'`; fechamento de comanda usa `'mesa'` fixo) — o
   conjunto real é 4 valores, não 3.

**Corrigido nesta mesma sessão, antes de prosseguir**, via
`supabase/migrations/0012_pedidos_comanda_id.sql`:
- `alter table pedidos add column comanda_id uuid references comandas(id) on delete set null` (nullable — nem todo pedido vem de comanda).
- `pedidos_tipo_check` recriado com os 4 valores reais.
- `create_pedido_com_itens()` e `upsert_pedido_com_itens()` (`create or replace function`) atualizadas para persistir `comanda_id`.
- Validado com teste funcional real contra `ros-pg-test`: criação com `comanda_id`, criação sem (permanece `NULL`), e upsert preservando/atualizando o valor em `ON CONFLICT` — os 3 cenários passaram.
- `packages/domain/src/index.ts`: `PedidoTipo` ampliado para incluir `'mesa'`.

Isto é exatamente o tipo de divergência que o princípio-guia desta fase
("migrar com base no MongoDB real") existe para capturar — só foi
encontrado por reler o código-fonte do handler em vez de confiar na
auditoria anterior.

---

## 4. Itens de pedido (`pedido_itens`) e comanda (`comanda_itens`)

Confirmado (Fase 5, re-confirmado aqui): o Mongo real grava:
- `pedido.itens[]`: **apenas** `{produto_id, nome, preco, quantidade}`.
- `comanda.itens[]`: `{id, produto_id, nome, preco, quantidade, observacao, operador_id, operador_nome, created_at}` — **exceto** os itens do seed de demonstração, que não têm `id`.

Nenhum dos dois tem `desconto` nem `subtotal` em nenhum documento real.

**Regra de transformação (determinística, documentada, sem inventar
regra de negócio):**
- `id` (só `pedido_itens`, que nunca tem, e `comanda_itens` do seed): gerado via `gen_random_uuid()` na função de upsert.
- `desconto`: **sempre `0`** — não existe no Mongo, `0` é o valor neutro que não altera nenhum cálculo (`subtotal - desconto = subtotal` quando `desconto=0`), não é uma suposição sobre o que o desconto "deveria" ter sido.
- `subtotal`: calculado como `preco * quantidade - desconto` (= `preco * quantidade`, já que `desconto=0`). Isto **não é uma nova regra de negócio** — é a mesma fórmula que `computeComanda()`/o cálculo de total de pedido já usam para somar itens hoje (`reduce((s,it) => s + preco*quantidade, 0)`); a migração só grava, por item, o termo que o Service já soma em memória. Se algum dia o Service passar a registrar desconto por item de verdade, o dado migrado (`desconto=0`) continua correto — representa fielmente que, no histórico, não havia desconto por item.
- `observacao` (só `pedido_itens`, que nunca tem): `''`.
- `created_at`: herda do documento pai (`pedido.created_at`/o `created_at` do próprio item de comanda, que já existe).

**Contagem de registros afetados por esta transformação** é calculada e
reportada pelo script no modo `--dry-run` e no log real (`itens_desconto_default`,
`itens_subtotal_calculado`, `itens_id_sintetizado`) — não é assumida, é
contada por coleção/empresa na hora da migração real.

**Snapshot histórico:** `nome`/`preco` são copiados exatamente como estão
no Mongo (já são o snapshot da venda, nunca o preço atual do produto —
confirmado, o Mongo nunca fez join com `produtos` para reescrever esses
campos). Nenhuma limitação nova aqui: o dado histórico necessário (nome e
preço no momento da venda) **já existe** e é preservado tal como está.

---

## 5. `comanda.pagamentos[]`

Confirmado de novo (Fase 1 e Fase 5): é cópia denormalizada dos mesmos
registros que já existem na coleção `pagamentos`. **Não migra para lugar
nenhum** — só a coleção `pagamentos` é migrada (item 9 da tabela). Validação
obrigatória pós-migração (pedida explicitamente): para cada comanda,
`length(mongo.comanda.pagamentos)` deve ser ≤ número de linhas em
`pagamentos` com aquele `comanda_id` (usar `≤` e não `=` estrito na
comparação bruta, porque a coleção `pagamentos` pode legitimamente ter
registros que nunca foram copiados para o array — ex.: um pagamento
criado por um fluxo diferente — mas o inverso, um pagamento no array sem
registro correspondente em `pagamentos`, indicaria uma dessincronização
real pré-existente e deve ser reportado como divergência, não silenciado).

---

## 6. `webhook_events`

Confirmado (Fase 1, Fase 4): log técnico de deduplicação de webhook, sem
valor de negócio retroativo, sem entidade de domínio em `domain.ts`. **Não
migrado** — a tabela existe (Fase 4) e começa vazia; deduplicação de novos
eventos passa a valer só depois do corte, quando o runtime passar a
escrever ali.

---

## 7. Multi-tenancy

A ferramenta produz, **antes** de migrar (fase de descoberta/dry-run) um
relatório `empresa → contagem por coleção`, lendo direto do Mongo, e o
mesmo relatório do lado Postgres depois de migrar, para comparação lado a
lado por empresa (não só um total global, que esconderia uma empresa
zerada compensada por outra duplicada).

---

## 8. Idempotência

Toda escrita é `upsert` por `id` (chave primária estável, ver §3):
- Entidades simples: `supabase.from(tabela).upsert(row, {onConflict:'id'})` — nativo do `supabase-js`, sem função dedicada.
- `pedidos`+itens e `comandas`+itens: RPCs dedicadas (migration `0011`, ver
  próxima seção) que fazem upsert do pai (`ON CONFLICT (id) DO UPDATE`) e
  **substituem** os filhos (`DELETE ... WHERE pedido_id/comanda_id = X` +
  `INSERT` do lote atual) — reexecutar com o mesmo documento de origem
  produz exatamente o mesmo estado final, nunca duplica item.

Rodar a ferramenta duas vezes seguidas com o mesmo dataset de origem deve
produzir contagens finais idênticas — este é um dos cenários de teste
obrigatórios (§ testes, cenário 3).

---

## 9. Riscos identificados nesta auditoria

1. Itens de `comanda_itens` do seed sem `id` — tratado (§3/§4), mas é o
   tipo de coisa fácil de esquecer se alguém rodar a migração só com um
   subconjunto de dados de teste que não inclua uma empresa "vinda do
   seed" — os testes desta fase incluem esse caso deliberadamente.
2. `pedido_contadores` desatualizado pós-migração (ver §2) — causaria
   colisão de `numero` na primeira ordem criada depois do corte se
   esquecido. Tratado como passo explícito e testado.
3. Migrar uma comanda cujo `mesa_id` aponta para uma mesa que, por algum
   motivo, não existe no lote migrado (dado inconsistente pré-existente no
   Mongo) — a FK `comandas.mesa_id not null references mesas` rejeitaria
   com erro claro (não silencioso) — comportamento correto, reportado como
   erro no log, não ignorado.
