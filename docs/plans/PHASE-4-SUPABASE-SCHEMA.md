# Fase 4 — Schema Supabase Completo

Migração MongoDB → Supabase. Escopo estrito: **schema/migrations/documentação
apenas**. Nenhuma linha de `app/api/[[...path]]/route.js` ou de
`lib/repositories/mongo/*` foi alterada. Nenhum `Supabase*Repository` foi
implementado. Nenhum dado foi migrado. **MongoDB continua sendo o único
runtime da aplicação.**

**Data:** 2026-08-10/11
**Pré-requisitos considerados:** `docs/plans/MONGO-TO-SUPABASE-AUDIT.md`
(auditoria completa) e `docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md` (remoção
das triggers de regra de negócio, condição para esta fase começar).

---

## 1. Resumo do que foi feito

7 novas migrations (`supabase/migrations/0002_*.sql` a `0008_*.sql`),
mais um ajuste em `supabase/seed.sql` (catálogo RBAC desatualizado, achado
durante esta fase) e em `README.md` (ordem de execução). Todas as
migrations foram **efetivamente testadas** contra uma instância real do
Postgres do Supabase (imagem `public.ecr.aws/supabase/postgres:17.6.1.158`,
rodada localmente via Docker só para validação desta fase — descartada ao
final, não faz parte do runtime do produto) — não apenas escritas e
assumidas corretas.

| Migration | Conteúdo |
|---|---|
| `0002_core_fixes.sql` | Colunas/constraints faltando em `empresas`, `usuarios`, `transacoes`, `integracoes`, `pedido_itens`; CHECKs de `pedidos.status`/`pedidos.pagamento` ampliados |
| `0003_pedido_numero_atomico.sql` | Contador atômico por empresa para `pedidos.numero` (resolve a race condition identificada na auditoria) |
| `0004_mesas.sql` | Tabela `mesas` |
| `0005_comandas.sql` | Tabelas `comandas` e `comanda_itens`; fecha as FKs `mesas.comanda_id` e `transacoes.comanda_id` |
| `0006_pagamentos.sql` | Tabela `pagamentos` (fonte relacional única, sem duplicar `comanda.pagamentos[]`) |
| `0007_webhook_events.sql` | Tabela `webhook_events`, com unicidade real (ausente no Mongo) |
| `0008_conversas_mensagens.sql` | Tabelas `conversas` e `mensagens` |

---

## 2. Tabelas (schema final — 20 tabelas)

**Já existiam (9), agora corrigidas onde necessário:** `empresas`,
`usuarios`, `papeis`, `permissoes`, `categorias`, `produtos`, `clientes`,
`pedidos`, `pedido_itens`, `transacoes`, `integracoes`, `auditoria`.

**Novas (8):** `mesas`, `comandas`, `comanda_itens`, `pagamentos`,
`webhook_events`, `conversas`, `mensagens`, `pedido_contadores` (infra
interna da numeração atômica, não é entidade de domínio).

Nenhuma tabela foi criada só por aparecer como "feature futura" —
`estoque`, `crm_leads`, `campanhas`, `fidelidade_pontos`,
`cashback_saldos`, `billing_assinaturas` etc. (comentário em
`0001_init.sql`) **continuam não implementadas**, por não fazerem parte do
domínio atualmente em produção.

---

## 3. Relacionamentos (FKs) — visão completa

```
empresas
 ├─ usuarios(empresa_id) CASCADE
 ├─ categorias(empresa_id) CASCADE
 │   └─ produtos(categoria_id) SET NULL
 ├─ produtos(empresa_id) CASCADE
 ├─ clientes(empresa_id) CASCADE
 ├─ pedidos(empresa_id) CASCADE, pedidos(cliente_id) SET NULL
 │   └─ pedido_itens(pedido_id) CASCADE, pedido_itens(produto_id) SET NULL
 ├─ transacoes(empresa_id) CASCADE, transacoes(pedido_id) SET NULL, transacoes(comanda_id) SET NULL
 ├─ integracoes(empresa_id) CASCADE
 ├─ auditoria(empresa_id) CASCADE
 ├─ mesas(empresa_id) CASCADE, mesas(comanda_id) SET NULL
 │   └─ comandas(mesa_id) RESTRICT
 │       ├─ comanda_itens(comanda_id) CASCADE, comanda_itens(produto_id) SET NULL, comanda_itens(operador_id) SET NULL
 │       ├─ pagamentos(comanda_id) SET NULL, pagamentos(pedido_id) SET NULL
 │       ├─ comandas(cliente_id) SET NULL, comandas(operador_id) SET NULL
 ├─ conversas(empresa_id) CASCADE, conversas(cliente_id) SET NULL, conversas(operador_id) SET NULL, conversas(pedido_ativo_id) SET NULL
 │   └─ mensagens(conversa_id) CASCADE, mensagens(operador_id) SET NULL
 ├─ webhook_events(empresa_id) CASCADE
 └─ pedido_contadores(empresa_id) CASCADE  [1:1, contador interno]
```

**Decisão em `mesa_id -> comandas` (`RESTRICT`, não `CASCADE`/`SET NULL`):**
nenhuma rota hoje apaga uma mesa (só desativa via `ativo=false`); `RESTRICT`
protege o histórico financeiro (comandas) contra um apagamento acidental de
mesa no futuro, sem afetar nenhum comportamento atual (o caminho nunca é
exercido).

**Decisão em `operador_id -> usuarios` (`SET NULL` em `comandas`,
`comanda_itens`, `mensagens`, `conversas`):** `DELETE /usuarios/:id` é uma
rota real e usada hoje. No Mongo, sem FK, apagar um usuário nunca afeta
comandas/mensagens históricas que ele operou — `SET NULL` é o equivalente
mais próximo em Postgres (preserva o registro histórico, só perde a
referência ao operador apagado) sem bloquear essa rota com um erro de FK
que não existe hoje.

---

## 4. Estratégia de `pedido_itens` / `comanda_itens`

Ambas confirmadas como **snapshot histórico**, não normalizadas contra o
preço atual do produto:

- `preco`, `nome`: copiados no momento da venda, nunca recalculados a
  partir de `produtos.preco`/`produtos.nome` atual (sem FK para esses
  campos, só `produto_id` como referência informativa, `on delete set
  null`).
- Colunas novas (não existiam nem no Mongo real, nem no schema Supabase
  anterior): `desconto`, `observacao`, `subtotal`. **Achado da auditoria
  Fase 1, reconfirmado aqui**: o Mongo hoje só grava
  `{produto_id, nome, preco, quantidade}` — a migração de dados (Fase 6)
  vai precisar sintetizar `id`, `desconto=0`, `observacao=''`,
  `subtotal=preco*quantidade` para cada item existente, não presumir que
  já existem.
- `subtotal` é **sempre calculado pelo Service** no momento da escrita
  (`preco*quantidade - desconto`) — nunca por trigger nem coluna gerada.

---

## 5. Estratégia de pagamentos

`pagamentos` é a **única fonte relacional**. `comanda.pagamentos[]`
(array denormalizado do Mongo, achado de duplicação da auditoria) **não
tem equivalente no schema Postgres** — não existe coluna, tabela auxiliar
nem view materializada replicando esse array. O valor pago de uma comanda
continua sendo uma **soma calculada pelo Service**
(`select sum(valor) from pagamentos where comanda_id=... and status='approved'`,
equivalente ao `computeComanda().pago` atual), nunca uma coluna
sincronizada por trigger.

Capacidades preservadas e garantidas por constraint:
- **Pagamentos parciais**: múltiplas linhas em `pagamentos` para a mesma
  `comanda_id`, cada uma com seu `valor` — soma feita pelo Service.
- **Múltiplas formas de pagamento**: `metodo` é texto livre (sem CHECK —
  ver §7), permite qualquer combinação.
- **Vínculo com pedido e com comanda**: `pedido_id`/`comanda_id`, ambos
  nullable, com `pagamentos_vinculo_check` garantindo que pelo menos um
  dos dois esteja preenchido (testado, ver §11).
- **Auditoria**: cada pagamento tem `created_at`/`updated_at`; a trilha de
  auditoria genérica (`auditoria`) continua registrando a ação no nível do
  Service, como hoje.
- **Idempotência do webhook Mercado Pago**: `unique(provider,
  provider_payment_id)` — testado explicitamente (reprocessar o mesmo
  evento do gateway falha na segunda tentativa, protegendo contra
  duplicar o pagamento).

---

## 6. Estratégia de `webhook_events`

Ver auditoria §10. Schema **mais rico que o uso atual do Mongo** por
pedido explícito desta fase (`payload jsonb`, `status`,
`processed_at`, além de `event_key`/`empresa_id`/`provider`/`received_at`
que já existiam). Isso não muda nada hoje — nenhum código escreve nesses
campos novos enquanto o runtime for Mongo — mas deixa a estrutura pronta
para quando o webhook do Mercado Pago (e futuros webhooks) forem
reescritos contra Supabase. `unique(event_key)` é uma constraint de
verdade, corrigindo o achado da auditoria de que a deduplicação hoje
depende só de lógica de aplicação.

---

## 7. Decisões sobre CHECK constraints (achados novos desta fase)

Dois achados que a auditoria original não tinha capturado, encontrados ao
cruzar route.js com os CHECKs já existentes no schema:

1. **`pedidos.status`**: o CHECK original só aceitava o vocabulário
   minúsculo (`recebido`..`cancelado`). O app aceita e usa, sem normalizar,
   um segundo vocabulário maiúsculo do fluxo de atendimento/delivery v3
   (`NOVO`, `CONFIRMADO`, `EM_PREPARACAO`, `PRONTO`, `SAIU_PARA_ENTREGA`,
   `ENTREGUE`, `CANCELADO` — ver `normPedidoStatus()` em route.js). Sem
   essa correção, um pedido criado pela Central de Atendimento com
   `status='ENTREGUE'` teria sido **rejeitado pelo banco**. Ampliado para
   os 12 valores reais.
2. **`pedidos.pagamento`**: `POST /comandas/:id/fechar` grava
   `comanda.pagamentos[0].metodo`, que vem de `b.metodo` em
   `POST /comandas/:id/pagamentos` **sem validação contra lista fixa**. Os
   4 métodos configuráveis por empresa são
   `dinheiro/pix/cartao_debito/cartao_credito` (ver `PAYMENT_METHODS` em
   `lib/integrations/payments/provider.js`), não os 3 do CHECK original
   (`pix/cartao/dinheiro`). Ampliado para os 5 valores realistas
   (mantendo `cartao` legado + os 2 novos).

Em contraste, **`pagamentos.metodo` e `mensagens.tipo` ficaram
deliberadamente sem CHECK** — são campos livres no código atual
(`b.metodo` e `data.messageType` da Evolution API, respectivamente); uma
constraint restritiva aqui rejeitaria valores que o Mongo aceita hoje sem
problema, violando o objetivo de "sem perda de comportamento".

---

## 8. Numeração de pedidos (concorrência)

**Achado da auditoria:** nem o Mongo (`countDocuments()+1`) nem a trigger
Postgres original (`select max(numero)+1`) eram atômicos — duas
transações concorrentes podiam ler o mesmo valor antes de qualquer
commitar.

**Solução implementada:** tabela `pedido_contadores(empresa_id pk,
ultimo_numero)`, populada via `INSERT ... ON CONFLICT (empresa_id) DO
UPDATE SET ultimo_numero = ultimo_numero + 1 RETURNING ultimo_numero` —
um upsert atômico padrão do Postgres, que serializa concorrência por lock
de linha (a segunda transação concorrente bloqueia até a primeira
commitar, então prossegue com o valor já incrementado). A trigger
`trg_pedidos_numero` (mecânica, mantida desde a Fase 3.5) continua
existindo sem alteração — só o **corpo** da função
`pedidos_set_numero()` foi trocado.

Isto **não é regra de negócio** — é um contador mecânico (equivalente a
uma sequence por tenant; Postgres não tem "sequence por chave" nativa,
então tabela+upsert é o padrão idiomático). A proteção estrutural
continua sendo a constraint `unique(empresa_id, numero)` já existente
desde a Fase 1 — a solução atômica evita que ela chegue a ser violada na
prática, mas a constraint continua como última linha de defesa.

**Testado sob concorrência real** (não só lido/assumido): 25 conexões
Postgres simultâneas inserindo pedidos para a mesma empresa produziram 25
números únicos e sequenciais (1..25), zero erros, zero duplicatas (ver
§11).

---

## 9. Multi-tenancy e RLS

- Todas as 17 tabelas de domínio (todas exceto `papeis`/`permissoes`,
  catálogo global, e `pedido_contadores`, infra interna sem exposição via
  API/repository) têm `empresa_id` e RLS habilitada.
- Policy padrão `<tabela>_tenant`: `USING (empresa_id = current_empresa_id())
  WITH CHECK (empresa_id = current_empresa_id())` — cobre SELECT, INSERT,
  UPDATE e DELETE simultaneamente (`FOR ALL`), sem nenhuma policy
  permissiva do tipo `USING (true)`.
- `empresas` usa a policy própria já existente (`empresa_self`, só a
  própria empresa). `usuarios` usa as 2 policies já existentes
  (`usuarios_select` todo mundo do tenant lê, `usuarios_write` só
  OWNER/ADMIN escrevem).
- **RLS continua defesa-em-profundidade, não substitui a aplicação**: com
  o backend usando `service_role` (que ignora RLS) + JWT local, o
  isolamento real continua sendo 100% responsabilidade do código da
  aplicação (`empresa_id` extraído do token, igual ao Mongo hoje). Isso é
  intencional e já estava documentado na auditoria — reforçado aqui.
- **Testado de verdade, não só assumido**: simulei duas empresas com dois
  usuários reais, autentiquei como cada um (`SET ROLE authenticated` +
  `request.jwt.claim.sub`) e confirmei que um usuário nunca vê, nunca
  edita e nunca apaga dado da outra empresa (SELECT filtra, UPDATE/DELETE
  afeta 0 linhas, INSERT cross-tenant é rejeitado pelo `WITH CHECK`).

---

## 10. Auth (sem alteração)

Conforme instruído: **nenhuma mudança na autenticação da aplicação nesta
fase.** Dois ajustes de schema foram necessários para não travar o JWT
local atual sem fechar a porta para Supabase Auth depois:

1. `usuarios.senha_hash` (coluna nova, NOT NULL) — formato `salt:hash`
   (scrypt) do `AuthProvider` local atual.
2. `usuarios.id` ganhou `default gen_random_uuid()` — o schema original
   pressupunha `id = auth.users.id` (comentário em `0001_init.sql`, nunca
   ativado). Um `default` não impede que uma migração futura de Auth
   insira explicitamente `id = auth.users.id`; só permite que o Service
   local continue gerando o id como já faz hoje (`uuidv4()` no Mongo).

A auditoria de Auth (Fase 8) continua uma etapa separada, não iniciada.

---

## 11. Testes executados

### 11.1 Testes de schema (novos, criados nesta fase)

Rodados contra uma instância Postgres real (imagem oficial do Supabase),
com todas as 11 migrations aplicadas em sequência de um banco vazio —
script em Python (`psycopg2`), **23/23 passando**:

| Categoria | Testes | Resultado |
|---|---|---|
| Criação de tabelas/migrations | Sequência completa 0001→0008 + triggers.sql + policies_rls.sql + seed.sql, do zero | OK, zero erros |
| RLS — isolamento SELECT | Usuário A não vê categoria/empresa de B | PASS |
| RLS — bloqueio de INSERT cross-tenant | `WITH CHECK` rejeita | PASS |
| RLS — UPDATE/DELETE cross-tenant | Afeta 0 linhas | PASS |
| CHECK `integracoes.tipo` | Aceita `mercadopago`, rejeita valor inválido | PASS |
| CHECK `pedidos.status`/`pagamento` | Aceita `ENTREGUE`/`cartao_credito`, rejeita lixo | PASS |
| UNIQUE `mesas(empresa_id,numero)` | Segunda inserção com mesmo número falha | PASS |
| UNIQUE `pagamentos.idempotency_key` | Segunda inserção com mesma key falha | PASS |
| UNIQUE `pagamentos(provider,provider_payment_id)` | NULLs convivem, valor real duplicado falha | PASS |
| CHECK `pagamentos_vinculo_check` | Rejeita pagamento sem comanda nem pedido | PASS |
| Índice único parcial `comandas(mesa_id) where aberta` | Segunda comanda aberta na mesma mesa falha | PASS |
| FK `comanda_itens.comanda_id` | Rejeita comanda inexistente | PASS |
| **Concorrência real de numeração** | 25 inserts simultâneos, mesma empresa | 25 números únicos 1..25, zero erros |

Ambiente de teste (container `ros-postgres-local`, porta 5433) foi
**descartado ao final** — não faz parte do produto, existiu só para validar
esta fase antes de entregar.

### 11.2 Regressão do runtime atual (MongoDB)

Executada porque foi pedida explicitamente, mesmo sabendo que esta fase
não altera nenhum arquivo que essa suíte exercita (`route.js`,
`lib/repositories/mongo/*`):

| Suíte | Resultado | Baseline |
|---|---|---|
| v1 | 40/40, 0 falhas | 40/40 |
| v2 | 39/39, 0 falhas | 39/39 |
| v3 | 32/33, 1 falha conhecida | 32/33 |

Idêntico ao baseline, como esperado.

---

## 12. Diferenças MongoDB vs Postgres a documentar (comportamento observável)

1. **`updated_at`**: `usuarios`, `categorias`, `produtos`, `clientes`
   **nunca** setam `updated_at` no Mongo (nem create nem update — conferido
   linha a linha em route.js). O Postgres já tinha (desde a Fase 1) um
   trigger `set_updated_at()` mecânico aplicado a essas 4 tabelas — mantido
   nesta fase. **Resultado**: quando a Fase 5/6 trocar o runtime, essas 4
   entidades passam a ter `updated_at` sempre preenchido, onde antes era
   sempre ausente. Decisão: **manter o automático no Postgres** (é
   estritamente mais informação, não quebra nenhum consumidor hoje — nada
   lê `updated_at` dessas 4 entidades em nenhuma tela) — mas registrado
   aqui explicitamente, conforme pedido.
2. **`mesas.numero` — nova constraint UNIQUE** que o Mongo nunca teve.
   `route.js` tem um bug conhecido e preservado (Fase 3) em
   `/mesas/configurar` (`numero: n` em vez do `numero` recalculado) que
   *poderia*, em tese, colidir números sob certas sequências de
   configurar/desativar mesas. Em Postgres isso passa a **falhar alto**
   (erro de constraint) em vez de silenciosamente duplicar — mudança de
   comportamento a avaliar antes da Fase 5 (ver riscos).
3. **`pedidos.numero` deixa de ter qualquer race condition** sob
   concorrência (era um risco real e silencioso no Mongo; no Postgres, com
   o contador atômico, nunca mais duplica nem gera erro por causa disso).
4. **Nova invariante estrutural**: no máximo uma comanda `'aberta'` por
   mesa (índice único parcial) — o Mongo só garantia isso por lógica de
   aplicação (checar `mesa.comanda_id` antes de abrir); uma falha de
   lógica que hoje passaria despercebida no Mongo passaria a ser um erro
   explícito no Postgres.
5. **CHECKs mais amplos que os originais** (`pedidos.status`,
   `pedidos.pagamento`) — corrigem incompatibilidades que já existiam
   antes desta fase (ver §7), não introduzem restrição nova além do que o
   app já produz.

---

## 13. Riscos restantes

1. **`mesas` unique(empresa_id,numero) interagindo com o bug conhecido de
   `/mesas/configurar`** (§12.2) — precisa ser avaliado explicitamente
   antes da Fase 5: ou corrigir o bug em `route.js`/futuro Service junto
   com a implementação do `SupabaseMesaRepository`, ou aceitar que colisões
   (raras, tecnicamente hoje já um bug) passem a gerar erro 500 em vez de
   dado errado silencioso.
2. **`usuarios.senha_hash NOT NULL`** vai precisar ser revisitado quando a
   Fase 8 (Auth) definir como usuários vindos de Supabase Auth (sem senha
   local) serão representados.
3. **RLS nunca foi exercida em produção** (só neste teste local) — quando
   a Fase 5/6 ligar de verdade a persistência Supabase, vale repetir os
   testes de isolamento do §11.1 contra o projeto Supabase real (não só o
   Postgres local), já que comportamento de rede/latência/pool de conexão
   podem revelar algo que o teste local não captura.
4. **Catálogo `papeis`/`permissoes` atualizado mas ainda não lido pelo
   app** — RBAC continua 100% hardcoded em `route.js`. Ficou em paridade
   com o código por precaução, mas a decisão de efetivamente usar essas
   tabelas (ou não) é separada desta migração.
5. **Nenhum dado real foi migrado** — esta fase só criou a estrutura vazia.
   Todos os riscos de migração de dados já listados em
   `docs/plans/MONGO-TO-SUPABASE-AUDIT.md` §15/§18 continuam válidos e
   pendentes para a Fase 6.

---

## 14. Próximos passos recomendados

1. **Fase 5** — implementar os 16 `Supabase*Repository`, satisfazendo os
   mesmos contratos de `packages/domain/src/index.ts` já usados pelos
   `Mongo*Repository`. Nenhuma lógica de negócio nos repositories (mesmo
   padrão fino já estabelecido na Fase 3).
2. Antes ou durante a Fase 5: decidir sobre o risco §13.1 (numeração de
   mesas) — é uma decisão de produto/comportamento, não de schema.
3. **Fase 6** — script de migração de dados, seguindo exatamente a
   estratégia já documentada em `docs/plans/MONGO-TO-SUPABASE-AUDIT.md`
   §15/§16 (ordem de carga, sintetização de campos de itens, validação por
   contagem/soma/amostra).
4. **Fase 7** — rodar `backend_test.py`/`_v2`/`_v3` com
   `DATABASE_PROVIDER=supabase` contra um projeto Supabase de staging real.
5. **Fase 8** (pode ser paralela a 5-7) — auditoria e implementação de
   Supabase Auth.

Não avancei para a Fase 5 automaticamente, conforme instruído.
