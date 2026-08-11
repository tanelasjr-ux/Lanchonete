# Fase 5 — Repositories Supabase

Migração MongoDB → Supabase. Implementa uma implementação Postgres/Supabase
para cada `Mongo*Repository` existente, satisfazendo exatamente os mesmos
contratos de `packages/domain/src/index.ts`. **Nenhuma linha de
`app/api/[[...path]]/route.js` foi alterada, nenhum switch de provider foi
criado, nenhum dado foi migrado, nenhum `Mongo*Repository` foi removido.**
MongoDB continua sendo o runtime padrão da aplicação.

**Data:** 2026-08-11
**Pré-requisito:** `docs/plans/PHASE-5-REPOSITORIES-AUDIT.md` (auditoria
obrigatória, feita antes de qualquer implementação).

---

## 1. Repositories criados

`lib/repositories/supabase/` — 15 arquivos (14 equivalentes diretos aos
`Mongo*Repository` + 1 helper extra sem contrato formal, mesmo padrão do
lado Mongo):

| Arquivo | Contrato (`domain.ts`) | Complexidade |
|---|---|---|
| `_shared.js` | — (helper interno: `unwrap`, `applyFilter`) | — |
| `empresaRepository.js` | `EmpresaRepository` | Direta |
| `usuarioRepository.js` | `UsuarioRepository` | Direta |
| `categoriaRepository.js` | `CategoriaRepository` | Direta |
| `produtoRepository.js` | `ProdutoRepository` | Direta |
| `clienteRepository.js` | `ClienteRepository` | RPC atômica (increment) |
| `transacaoRepository.js` | `TransacaoRepository` | Direta |
| `auditoriaRepository.js` | `AuditoriaRepository` | Direta |
| `integracaoRepository.js` | `IntegracaoRepository` | Upsert por chave composta |
| `mesaRepository.js` | `MesaRepository` | Update condicional |
| `pedidoRepository.js` | `PedidoRepository` | **Join/split de itens + RPC de numeração** |
| `comandaRepository.js` | `ComandaRepository` | **Join/split de itens + reconstrução de pagamentos + no-op documentado** |
| `pagamentoRepository.js` | `PagamentoRepository` | Direta |
| `conversaRepository.js` | `ConversaRepository` | RPC atômica (increment) |
| `mensagemRepository.js` | `MensagemRepository` | Direta |
| `webhookEventsRepository.js` | — (sem contrato, mesmo padrão do Mongo) | Upsert idempotente |

Todos recebem o client Supabase por injeção de dependência
(`createXRepository(supabase)`), exatamente como os `Mongo*Repository`
recebem `database` — `supabase` é obtido via `getSupabaseAdmin()`
(`lib/integrations/supabase.js`, já existente, não alterado).

Migration adicional necessária: `supabase/migrations/0009_repository_support_functions.sql`
(3 funções SQL mecânicas — ver §4).

---

## 2. Contratos implementados

Todos os métodos de todos os 14 `Mongo*Repository` foram implementados com
**mesma assinatura** (nome, ordem de parâmetros) no lado Supabase — nenhum
método foi renomeado, removido ou teve a ordem de parâmetros alterada, o
que os torna intercambiáveis atrás dos mesmos contratos de `domain.ts` sem
exigir nenhuma mudança em quem os chama (`route.js`, quando a troca de
provider acontecer numa fase futura).

**Correção em `domain.ts` feita nesta fase** (achado da auditoria, ver
`PHASE-5-REPOSITORIES-AUDIT.md` §5): a interface `Comanda` não tinha o
campo `pagamentos`, apesar de `computeComanda()` (Service, em `route.js`)
sempre ter dependido dele existir em tempo de execução. Adicionado como
`pagamentos: PagamentoResumo[]`, com `PagamentoResumo` como novo tipo
documentado explicitamente como *read-model denormalizado* (não é a fonte
de verdade — a fonte é a tabela `pagamentos`).

---

## 3. Diferenças Mongo/Supabase e como cada uma foi tratada

| Diferença | Tratamento |
|---|---|
| `Pedido.itens`/`Comanda.itens` embutidos no Mongo, tabelas filhas (`pedido_itens`/`comanda_itens`) no Postgres | Leitura usa *resource embedding* do PostgREST (`select('*, itens:pedido_itens(*)')`) — o Postgres devolve o join pronto, sem N+1 queries. Escrita separa `.itens` do payload: insere o pai, depois as linhas filhas com `pedido_id`/`comanda_id` preenchido. |
| `Comanda.pagamentos` existe em runtime (lido por `computeComanda()`) mas não tem coluna no Postgres (decisão da Fase 4: tabela própria) | Leitura reconstrói via embedding a partir da tabela `pagamentos` (`pagamentos(id,metodo,valor,status,provider,created_at)`, mesmos campos do resumo antigo). `pushPagamentoResumo()` vira **no-op documentado** — o dado já foi gravado por `PagamentoRepository.create()` antes dessa chamada, na mesma rota. |
| `$inc` atômico do Mongo (`ClienteRepository.incrementarMetricasPedido`, `ConversaRepository.incrementarNaoLidas`) | `supabase-js` não tem equivalente direto — 2 funções SQL mecânicas (`increment_cliente_metricas`, `increment_conversa_nao_lidas`, migration `0009`), chamadas via `.rpc()`. Mesma classificação "mecânica, não regra de negócio" já usada para a numeração atômica na Fase 4. |
| `PedidoRepository.nextNumero()` | Chama a **mesma** função SQL (`next_pedido_numero`) que a trigger `pedidos_set_numero()` usa (extraída da trigger para ser reutilizável) — nunca dois caminhos de numeração, nunca reintroduz a race condition que a Fase 4 corrigiu. |
| `webhook_events` sem unicidade real no Mongo, `unique(event_key)` real no Postgres | `WebhookEventsRepository.upsert()` usa `ON CONFLICT (event_key) DO NOTHING` + `.select()`: quando há conflito, zero linhas voltam — assim detectamos "evento já processado" sem SELECT extra. |
| Colunas novas (`desconto`, `subtotal`) em `pedido_itens`/`comanda_itens` que o Service atual não popula | **Não implementado no repository** (calcular seria regra de negócio, proibido explicitamente). Ficam com o default do schema (`0`) até uma fase futura atualizar o Service para computar e passar esses valores — limitação documentada, não bug. |
| Erros de constraint (`supabase-js` devolve `{data,error}`, nunca lança exceção) | Helper `unwrap()` (`_shared.js`) converte em `Error` JS normal, preservando `code`/`details`/`hint` do Postgres — nunca mascarado, nunca silenciado, nunca vira sucesso fictício. |
| `numeric`/`bigint` do Postgres | Testado empiricamente (não assumido): a versão do PostgREST usada devolve número JSON nativo, não string — nenhuma conversão extra necessária ao ler. Escrita continua fazendo `Number(...)` nos valores monetários, mesmo padrão defensivo dos `Mongo*Repository`. |
| snake_case vs camelCase | Não existe — toda a base (Mongo, domain.ts, Postgres) já usa snake_case consistentemente. Confirmado por inspeção, não presumido. |

---

## 4. Migration de apoio (`0009_repository_support_functions.sql`)

3 funções SQL, todas classificadas como **mecânicas** (mesmo critério da
Fase 3.5/4 — não decidem nada de negócio, só executam operações atômicas
que `supabase-js` não expressa diretamente):

1. `next_pedido_numero(empresa_id)` — extraída da trigger
   `pedidos_set_numero()` para ser reutilizável via RPC pelo repository e
   pela trigger ao mesmo tempo (mesma fonte atômica, nunca duplicada).
2. `increment_cliente_metricas(empresa_id, cliente_id, valor)` — equivalente
   ao `$inc` de `total_pedidos`/`total_gasto`.
3. `increment_conversa_nao_lidas(empresa_id, conversa_id, ultima_mensagem, ultima_mensagem_em, status)` —
   equivalente ao `$set + $inc` atômico de `nao_lidas`.

---

## 5. Multi-tenancy

Confirmado, método por método, nos 15 arquivos: **todo método tenant-scoped
recebe `empresaId` como parâmetro explícito**, e toda query inclui
`.eq('empresa_id', empresaId)` — nunca dependendo só de RLS. Testado
explicitamente com dois "tenants" reais usando o **service role** (que
ignora RLS, exatamente como a aplicação usa em produção via
`getSupabaseAdmin()`): mesmo bypassando RLS, o escopo por `empresa_id` na
query impede um tenant de ver dado do outro — a defesa real está na
aplicação, RLS é a camada extra, exatamente como documentado na Fase 4.

---

## 6. Ambiente de teste

Reaproveitado o padrão da Fase 4 (imagem oficial `public.ecr.aws/supabase/postgres:17.6.1.158`),
**mais um componente novo necessário só para esta fase**: `public.ecr.aws/supabase/postgrest:v14.16`
(a camada REST real que `supabase-js` fala por baixo — sem isso, os
repositories não podiam ser exercitados de verdade, só o SQL). JWT `HS256`
com `role: service_role` mintado localmente (mesmo mecanismo de
`SUPABASE_SERVICE_ROLE_KEY`). Scripts de teste em Node (`.mjs`, ESM),
executados temporariamente dentro do próprio repositório (para resolução
de `node_modules`) e **apagados ao final** — não fazem parte do código
entregue.

---

## 7. Testes executados

### 7.1 Repositories simples (9 arquivos) — 24/24 passando

Criação, leitura (`findById` existente/inexistente via `.maybeSingle()`),
atualização, filtros, ordenação, cascade delete (`deleteManyByCategoria`),
increment atômico via RPC (`incrementarMetricasPedido` com 2 chamadas
concorrentes-em-sequência somando corretamente), `count`, upsert
(`IntegracaoRepository`, incluindo `tipo='mercadopago'`), `createMany` +
update condicional guardado (`syncStatusOcupada`), isolamento multi-tenant,
e 2 cenários de erro (CHECK inválido, UNIQUE duplicado) confirmando que
erro nunca é mascarado.

### 7.2 Repositories complexos (6 arquivos) — 20/20 passando

Numeração atômica sequencial via RPC; criação de pedido com itens
(separação + join na leitura); update de pedido para `status='ENTREGUE'`
preservando itens; fluxo completo de comanda (mesa → abrir → pushItem ×2 →
setDerivados → updateItemCampos → pagamento parcial via
`PagamentoRepository` → `pushPagamentoResumo` no-op → `findById`
reconstrói `.pagamentos` → **`computeComanda()` real, sem nenhuma
alteração, calcula `.pago`/`.restante` corretamente usando esse
`.pagamentos` reconstruído** → `removeItem`); constraint de vínculo de
pagamento; UNIQUE de `idempotency_key`; conversa + increment atômico de
`nao_lidas`; mensagens ordenadas preservando `provider_message_id`
(identificador externo da Evolution); idempotência real de
`webhook_events`; isolamento multi-tenant em pedidos/comandas/conversas.

### 7.3 Matriz de equivalência Mongo ↔ Supabase

Cenários executados **lado a lado, nos dois backends, no mesmo script**,
comparando o resultado real (não just a leitura do código):

| Entidade | Cenário | Mongo | Supabase | Equivalente? |
|---|---|---|---|---|
| Empresa | `findById` após `create` | Igual | Igual | ✅ |
| Categoria | `list` ordenado por `ordem` | `A,B` | `A,B` | ✅ |
| Mesa | `syncStatusOcupada` não reabre mesa livre | `livre` | `livre` | ✅ |
| Pedido | `.itens` (embutido vs join) — mesma forma e valores | `[{nome:"X",preco:10,quantidade:3}]` | idêntico | ✅ |
| Comanda | `computeComanda()` (mesma função) com itens+desconto+taxa | `subtotal=40,total=38.5` | `subtotal=40,total=38.5` | ✅ |
| Isolamento | `list(empresaId inexistente)` | `[]` | `[]` | ✅ |

**7/7 equivalentes.** Os demais métodos (não incluídos no script lado a
lado por redundância) já são exercitados continuamente contra o Mongo pela
suíte `backend_test*.py` (que passa pela API real, logo pelos
`Mongo*Repository` reais) e, do lado Supabase, pelos 44 testes das seções
7.1/7.2 — a combinação das duas evidências é o que sustenta a equivalência
funcional completa, não só os 7 cenários side-by-side.

### 7.4 Regressão do schema (Fase 4) após a migration 0009

Re-verificado estruturalmente (não só assumido): 17 tabelas de domínio
continuam com RLS habilitada, 18 policies intactas, **zero triggers de
regra de negócio** (só as mecânicas: 7×`set_updated_at` + `pedidos_set_numero`).
*Nota:* a Fase 4 (`PHASE-4-SUPABASE-SCHEMA.md`) tinha um erro de contagem
("18 tabelas com RLS" — o número correto é 17); corrigido nesta fase.

### 7.5 Regressão do runtime MongoDB

| Suíte | Resultado | Baseline |
|---|---|---|
| v1 | 40/40 | 40/40 |
| v2 | 39/39 | 39/39 |
| v3 | 32/33 (falha conhecida) | 32/33 |

Idêntico — esperado, já que nenhuma linha de `route.js` ou
`lib/repositories/mongo/*` foi tocada.

---

## 8. Erros — comportamento confirmado

- Erro de `CHECK`/`UNIQUE`/`FOREIGN KEY` **sempre propaga** como exceção JS
  (testado: `integracoes.tipo` inválido, `usuarios.email` duplicado,
  `pagamentos.idempotency_key` duplicado, `pagamentos_vinculo_check`) —
  nunca é engolido, nunca vira um retorno de sucesso, nunca gera dado
  fictício no lugar.
- `findById`/`findByX` devolvem `null` (não erro) quando não encontram —
  via `.maybeSingle()`, nunca `.single()` (que lançaria erro em zero
  linhas, diferente do comportamento `findOne()` do Mongo).

---

## 9. Integrações — confirmado que nada foi alterado

`lib/integrations/evolution.js`, `lib/integrations/n8n.js`,
`lib/integrations/payments/{provider,mercadopago}.js` — **zero alterações**
(confirmado via `git diff`). Nenhum mock novo, nenhuma credencial
hardcoded, nenhuma alteração nos adapters existentes.

---

## 10. Build/qualidade

Sem ESLint nem `tsconfig.json` configurados no projeto (mesma situação já
reportada nas Fases 2-4) — adicionar isso exigiria decisões de configuração
(regras, `tsconfig` strictness) fora do escopo pontual desta fase.
**Não configurado**, documentado aqui em vez de virar refatoração:
recomendação é tratar como uma fase própria, não encaixar de raspão. `next build`
não foi executado por não haver nenhuma mudança em `app/`/rotas que o
justificasse (só `lib/repositories/supabase/*`, ainda não importado por
nenhuma rota).

---

## 11. Limitações conhecidas (não são bugs, são decisões documentadas)

1. `pedido_itens.desconto`/`.subtotal` e `comanda_itens.desconto` ficam com
   o default `0` até o Service ser atualizado numa fase futura para
   calcular e enviar esses valores — repository não calcula (seria regra
   de negócio).
2. `pushPagamentoResumo()` é no-op no lado Supabase — funciona porque a
   ordem de chamadas em `route.js` já grava o pagamento na tabela própria
   *antes* dessa chamada. Se essa ordem mudar no futuro, este método
   precisa ser revisitado.
3. Nenhum destes repositories é usado por `route.js` ainda — existem, são
   testados isoladamente, mas o *switch* de provider é trabalho de uma
   fase futura (não desta).

---

## 12. Riscos

1. **Ambiente de teste não é o Supabase real** — é Postgres+PostgREST
   oficiais rodando localmente sem Kong/GoTrue na frente. Comportamento de
   rede, cotas, connection pooling (PgBouncer) e latência real do Supabase
   hospedado não foram exercitados. Recomenda-se repetir pelo menos os
   testes críticos (§7.2) contra um projeto Supabase real de staging antes
   da Fase 6.
2. ~~`pedidoRepo.create`/`comandaRepo.create` fazem 2 operações separadas...~~
   **RESOLVIDO** (correção preventiva antes da Fase 6, 2026-08-11): ambos
   agora usam uma função PL/pgSQL (`create_pedido_com_itens`/
   `create_comanda_com_itens`, migration `0010_atomic_create_functions.sql`)
   que insere pai e filhos na mesma função — atômica por natureza (se
   qualquer instrução falhar, tudo é revertido). A função não decide nenhum
   valor de negócio, só persiste o que o Service já calculou (mesma
   classificação "mecânica" das demais funções de apoio). Testado
   explicitamente: 2 cenários de sucesso (pedido+itens e comanda+item
   persistidos juntos) e 2 cenários de falha proposital (item com
   `quantidade` inválida) confirmando que o pai **não** fica órfão — nem
   pedido nem comanda são criados quando o item falha. Achado durante a
   própria correção: a primeira versão usava `jsonb_populate_record` com
   base nula, que zera silenciosamente qualquer campo omitido em vez de
   aplicar o default da coluna (ex.: `subtotal` viraria `NULL` em vez de
   `0`) — corrigido para inserção explícita coluna a coluna com os mesmos
   defaults já declarados no schema.
3. Ver também os riscos já registrados e ainda não resolvidos das Fases 1
   e 4 (Auth, numeração de mesas, etc.) — continuam válidos e não foram
   reavaliados nesta fase por não fazerem parte do seu escopo.

---

## 13. Próximo passo recomendado

**Fase 6** — script de migração de dados (Mongo → Supabase), seguindo a
estratégia já documentada em `MONGO-TO-SUPABASE-AUDIT.md` §15/§16, usando
estes repositories como destino da escrita. Antes disso, avaliar o risco
§12.2 (atomicidade de criação pai+filhos) e decidir se vale a pena resolver
antes ou durante a Fase 6. Não avancei para a Fase 6 automaticamente,
conforme instruído.
