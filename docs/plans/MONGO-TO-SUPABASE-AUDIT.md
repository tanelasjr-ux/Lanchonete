# Auditoria Completa — Migração MongoDB → Supabase

Documento de **auditoria e planejamento apenas**. Nenhum código, schema ou
repository foi alterado para produzir este documento. Toda informação abaixo
foi extraída lendo o código real nesta data — `app/api/[[...path]]/route.js`
(1430 linhas, integral), os 16 arquivos em `lib/repositories/mongo/`,
`packages/domain/src/index.ts` (327 linhas, integral), os 4 arquivos SQL em
`supabase/`, `lib/integrations/payments/{provider,mercadopago}.js`, e o
histórico de testes em `test_result.md` — não apenas de memória de sessões
anteriores ou de documentação.

**Data:** 2026-08-10
**Escopo do que já foi feito:** Fase 1 (auditoria original), Fase 2
(`packages/domain/src/index.ts` completo), Fase 3 (16 coleções extraídas
para `lib/repositories/mongo/*`, runtime ainda 100% MongoDB).
**Escopo deste documento:** preparar a Fase 4 (schema Supabase) em diante,
sem executar nada ainda.

---

## 1. Estado atual

| Camada | Estado |
|---|---|
| Runtime de dados | 100% MongoDB via `MONGO_URL`. Nenhum dado real passou por Supabase ainda. |
| Acesso a dados | Todas as 16 coleções de domínio passam por `lib/repositories/mongo/*Repository.js`. `route.js` só chama `db.collection()` direto em 3 pontos deliberados (ver §5). |
| Contratos de domínio | `packages/domain/src/index.ts` define todas as entidades e repositórios — completo, mas é só TypeScript de documentação: **não há compilador TypeScript no projeto** (`package.json` não tem `typescript` nas dependências, não há `tsconfig.json`), então nada valida esses contratos automaticamente hoje. |
| Schema Supabase | Existe desde antes da Fase 1, cobre só os módulos "v1" (9 tabelas). Não foi tocado em nenhuma fase. |
| RLS Supabase | Definida para as 9 tabelas existentes, depende de `auth.uid()` (Supabase Auth) — inerte enquanto o app usar JWT local + service role key. |
| Auth | JWT local (HMAC-SHA256 + scrypt), 100% em código, sem Supabase Auth. Decisão tomada: migrar para Supabase Auth também, mas **sem auditoria própria ainda**. |
| RBAC | 100% hardcoded em `route.js` (`ROLES`/`PERMISSIONS`, função `can()`). As tabelas `papeis`/`permissoes` existem no Supabase (com seed) mas **não são lidas pelo app em nenhum lugar** — são catálogo morto até serem conectadas. |
| Testes | `backend_test.py`/`_v2`/`_v3`, baseline estável em v1 40/40, v2 39/39, v3 32/33 (1 falha conhecida e aceita, não é bug). Confirmado idêntico em cada um dos 8 lotes da Fase 3. |
| Infra | EasyPanel/Hostinger tem Evolution API + n8n rodando; nenhum serviço "app" nem banco publicado ainda. Fora do escopo desta auditoria. |

---

## 2. Inventário completo das entidades

16 coleções MongoDB de domínio + 1 coleção de infraestrutura
(`webhook_events`, não é entidade de domínio) + 2 tabelas Supabase-only sem
equivalente Mongo (`papeis`/`permissoes`, catálogo RBAC estático).

| # | Coleção Mongo | Repository (`lib/repositories/mongo/`) | Domain type | Chave lógica |
|---|---|---|---|---|
| 1 | `empresas` | `empresaRepository.js` | `Empresa` | `id` (raiz do tenant, sem `empresa_id` próprio) / `slug` único global |
| 2 | `usuarios` | `usuarioRepository.js` | `Usuario` | `id` por tenant; `email` único **global** |
| 3 | `categorias` | `categoriaRepository.js` | `Categoria` | `id` por tenant |
| 4 | `produtos` | `produtoRepository.js` | `Produto` | `id` por tenant |
| 5 | `clientes` | `clienteRepository.js` | `Cliente` | `id` por tenant |
| 6 | `pedidos` | `pedidoRepository.js` | `Pedido` (+ itens embutidos) | `id` por tenant; `(empresa_id, numero)` deveria ser único (ver §11) |
| 7 | `transacoes` | `transacaoRepository.js` | `Transacao` | `id` por tenant; append-only |
| 8 | `auditoria` | `auditoriaRepository.js` | `Auditoria` | `id` por tenant; append-only |
| 9 | `integracoes` | `integracaoRepository.js` | `Integracao` | `(empresa_id, tipo)` único |
| 10 | `mesas` | `mesaRepository.js` | `Mesa` | `id` por tenant |
| 11 | `comandas` | `comandaRepository.js` | `Comanda` (+ itens e pagamentos embutidos) | `id` por tenant |
| 12 | `pagamentos` | `pagamentoRepository.js` | `PagamentoRegistro` | `id` por tenant; append-only |
| 13 | `conversas` | `conversaRepository.js` | `Conversa` | `id` por tenant |
| 14 | `mensagens` | `mensagemRepository.js` | `Mensagem` | `id` por tenant; append-only |
| 15 | `webhook_events` | — (deliberadamente sem repository, ver §5) | — | `eventKey` (string composta) |
| — | `papeis` / `permissoes` | — (não existe no Mongo; só Supabase, não lido pelo app) | — | catálogo estático |

### 2.1 Campos reais por entidade (lidos do código, não do domain.ts)

**`empresas`** — `id, nome, slug, plano, telefone, endereco, moeda, nome_comercial, cnpj, whatsapp, email, logo, horario_funcionamento, config{feature_flags{10 bools}, appearance{cor_principal,cor_secundaria,tema,nome_exibido}, pagamentos{metodos{4 bools},taxa_servico_padrao}}, ativo, created_at`. **Nunca tem `updated_at` no Mongo** apesar do PUT setar `upd.updated_at` — na verdade sim, `PUT /empresa` seta `updated_at` explicitamente (route.js:588). Único ponto de escrita: registro (cria) e `PUT /empresa` (atualiza, com merge profundo de `config.appearance`/`config.pagamentos`/`config.feature_flags`).

**`usuarios`** — `id, empresa_id, nome, email, senha_hash, papel, ativo, created_at`. **Nunca seta `updated_at`** em nenhum ponto (nem create nem update) — diferente de quase todas as outras entidades.

**`categorias`** — `id, empresa_id, nome, ordem, ativo, created_at`. **Nunca seta `updated_at`** (nem create nem update — confirmado lendo os handlers POST/PUT).

**`produtos`** — `id, empresa_id, categoria_id, nome, descricao, preco, imagem, disponivel, ativo, created_at`. **Nunca seta `updated_at`.**

**`clientes`** — `id, empresa_id, nome, telefone, email, endereco, observacoes, total_pedidos, total_gasto, created_at`. **Nunca seta `updated_at`.**

**`pedidos`** — `id, empresa_id, numero, cliente_id, cliente_nome, itens[], tipo, pagamento, status, observacoes, total, created_at, updated_at` (este seta `updated_at` em todo PUT). Campo extra opcional `comanda_id` só existe quando o pedido nasce de um fechamento de comanda. `itens[]` real hoje: **`{produto_id, nome, preco, quantidade}`** — sem `id`, sem `desconto`, sem `observacao`, sem `subtotal`. `POST /pedidos` aceita `b.itens` do cliente **sem validar o formato de cada item** (só soma `preco*quantidade` para o total).

**`transacoes`** — `id, empresa_id, tipo, categoria, descricao, valor, pedido_id, data, created_at` + `comanda_id` opcional (só quando originado de fechamento de comanda). Append-only confirmado (nenhum update/delete em nenhuma rota).

**`auditoria`** — `id, empresa_id, usuario_id, usuario_nome, acao, entidade, entidade_id, dados, created_at`. Append-only + leitura.

**`integracoes`** — `id, empresa_id, tipo(evolution|n8n|mercadopago), config, status(nao_configurado|configurado), created_at, updated_at`. `config` varia por tipo: evolution `{serverUrl,apiKey,instance}`, n8n `{webhookUrl,apiKey,eventos[]}`, mercadopago `{mode,accessToken,webhookSecret}`.

**`mesas`** — `id, empresa_id, numero, nome, capacidade, status(livre|ocupada|aguardando_pagamento|reservada), comanda_id, ativo, created_at, updated_at`.

**`comandas`** — `id, empresa_id, mesa_id, mesa_nome, cliente_id, cliente_nome, pessoas, status(aberta|fechada), itens[], desconto, desconto_tipo(valor|percent), taxa_servico_percent, pagamentos[], operador_id, operador_nome, aberta_em, fechada_em, created_at, updated_at` + campos derivados persistidos `subtotal, desconto_valor, taxa_valor, total, pago, restante` (gravados por `setDerivados()`, sempre recalculados por `computeComanda()` no Service, nunca a fonte de verdade). `itens[]` real: `{id, produto_id, nome, preco, quantidade, observacao, operador_id, operador_nome, created_at}` — **sem `desconto` nem `subtotal` por item**. `pagamentos[]` é uma **cópia denormalizada** de um subconjunto de campos que também existem na coleção `pagamentos` (`id, metodo, valor, status, provider, created_at`) — dado duplicado (ver §9).

**`pagamentos`** — `id, empresa_id, comanda_id, pedido_id, metodo, valor, status, provider(manual|mercadopago), provider_payment_id, external_reference, idempotency_key, qr_code?, qr_code_base64?, ticket_url?, created_at, updated_at`. Append-only. `status` para pagamentos Mercado Pago usa o vocabulário normalizado em `lib/integrations/payments/mercadopago.js`: `pending | approved | rejected | cancelled | refunded | unknown`.

**`conversas`** — `id, empresa_id, cliente_id, contato_nome, contato_numero, status(ABERTA|AGUARDANDO_EQUIPE|AGUARDANDO_CLIENTE|RESOLVIDA), ultima_mensagem, ultima_mensagem_em, nao_lidas, operador_id, pedido_ativo_id, created_at, updated_at`.

**`mensagens`** — `id, empresa_id, conversa_id, direcao(in|out), tipo(text|image|audio|document|conversation), texto, media_url, from_me, status, provider_message_id, operador_id, created_at`. `operador_id` só é setado em mensagens `out` (enviadas pela equipe); mensagens `in` (do cliente) não têm essa chave no documento (ausente, não `null`). Append-only.

**`webhook_events`** — `eventKey (string composta "${empresaId}:${dataId}:${requestId}"), empresa_id, provider, received_at`. Só usada pelo webhook do Mercado Pago para dedupe.

---

## 3. Mapeamento MongoDB → Supabase

| Coleção Mongo | Tabela Supabase | Situação |
|---|---|---|
| `empresas` | `public.empresas` | Existe, **faltam 6 colunas**: `nome_comercial, cnpj, whatsapp, email, logo, horario_funcionamento` |
| `usuarios` | `public.usuarios` | Existe, **falta `senha_hash`**; schema pressupõe `id = auth.users.id`, incompatível com JWT local |
| `categorias` | `public.categorias` | Compatível |
| `produtos` | `public.produtos` | Compatível |
| `clientes` | `public.clientes` | Compatível |
| `pedidos` | `public.pedidos` | Compatível na tabela pai; `itens` diverge (ver §7) |
| — (embutido) | `public.pedido_itens` | Existe, mas **schema não bate** com a decisão de snapshot histórico (falta `desconto`, `subtotal`, `observacao`, `created_at`) |
| `transacoes` | `public.transacoes` | Existe, **falta coluna `comanda_id`** |
| `auditoria` | `public.auditoria` | Compatível |
| `integracoes` | `public.integracoes` | Existe, **CHECK constraint não inclui `'mercadopago'`** — um `insert`/`upsert` com `tipo='mercadopago'` quebraria hoje |
| `mesas` | — | **Tabela não existe** |
| `comandas` | — | **Tabela não existe** |
| — (embutido) | — | **`comanda_itens` não existe** |
| `pagamentos` | — | **Tabela não existe** |
| `webhook_events` | — | **Tabela não existe** |
| `conversas` | — | **Tabela não existe** |
| `mensagens` | — | **Tabela não existe** |
| — | `public.papeis`, `public.permissoes` | Existem e têm seed, mas **nenhum código as lê** — RBAC é 100% hardcoded em `route.js`. Não fazem parte da migração de dados (não há dado Mongo equivalente); decisão de conectá-las ou não é separada desta migração. |

**Resumo:** 6 de 15 tabelas de domínio (mesas, comandas, comanda_itens, pagamentos, webhook_events, conversas, mensagens) **não existem** no Supabase. Das 9 que existem, 4 têm colunas/constraints faltando (`empresas`, `usuarios`, `transacoes`, `integracoes`) e 1 (`pedido_itens`) tem schema desalinhado com a decisão de snapshot histórico.

---

## 4. Schema Supabase existente (resumo técnico)

- `supabase/migrations/0001_init.sql`: 9 tabelas de domínio (`empresas, usuarios, papeis, permissoes, categorias, produtos, clientes, pedidos, pedido_itens, transacoes, integracoes, auditoria`), extensão `pgcrypto`, PKs `uuid default gen_random_uuid()`, índices por `empresa_id` em todas as tabelas escopadas, unique `(empresa_id, numero)` em pedidos, unique `(empresa_id, tipo)` em integracoes, unique `slug` em empresas, unique `email` em usuarios.
- `supabase/policies_rls.sql`: RLS habilitada nas 9 tabelas acima (não nas 6 que faltam). `current_empresa_id()`/`current_papel()` dependem de `auth.uid()` (Supabase Auth).
- `supabase/triggers.sql`: `set_updated_at()` (genérico, aplicado a `empresas, usuarios, categorias, produtos, clientes, pedidos, integracoes` — nota: **`clientes` está na lista do trigger mas o Mongo nunca seta `updated_at` em clientes**, então isso já é um comportamento novo introduzido pelo Postgres, não uma preservação); `pedidos_set_numero()` (numeração via `max()+1`, mesma race condition do Mongo, não corrigida); `pedido_recalc_total()` (recalcula `pedidos.total` a partir de `pedido_itens` — **regra de negócio em trigger**, conflita com a decisão #2); `pedido_on_conclusao()` (gera receita + atualiza cliente ao `status='concluido'` — **regra de negócio em trigger, e só cobre `'concluido'`, não `'ENTREGUE'`** — deixaria de gerar receita para pedidos de delivery/atendimento no vocabulário v3).
- `supabase/seed.sql`: seed global de `papeis`/`permissoes` (RBAC catalog, não usado pelo app hoje).

**Achado crítico:** `triggers.sql` já implementa exatamente as duas regras de negócio que a decisão #2 do usuário proíbe de ficar em trigger (`pedido_recalc_total`, `pedido_on_conclusao`). Esses triggers foram escritos **antes** dessa decisão ser tomada (na sessão anterior) e nunca foram revisados à luz dela. Eles precisam ser removidos ou reescritos como não-autoritativos antes da Fase 4, ou a Fase 4 vai herdar uma contradição arquitetural.

---

## 5. Exceções documentadas (o que continua fora do padrão Repository)

Confirmado por grep no `route.js` atual — só restam 3 categorias de acesso direto a `db.collection()`:

1. `ensureIndexes()` — roda uma vez por processo, cria índices. Infra, não repository.
2. Seed bulk-insert (`insertMany` de categorias/produtos/clientes/mesas/conversas/mensagens/integracoes/pedidos/transacoes em `seedEmpresa()`) — fora do escopo do contrato `Repository<T>.create()` (singular). `comandas` no seed já usa `comandaRepository.create()` (é um insert singular).
3. `webhook_events` — usado só pelo webhook assinado do Mercado Pago para idempotência técnica. Não é uma entidade de domínio (não tem contrato em `domain.ts`, não aparece em nenhuma tela do produto).

---

## 6. Relacionamentos

```
empresas (raiz do tenant)
 ├─ usuarios            (empresa_id)         email único GLOBAL (nao por empresa)
 ├─ categorias          (empresa_id)
 │   └─ produtos        (empresa_id, categoria_id nullable, on delete → categoria_id=null)
 ├─ clientes            (empresa_id)
 ├─ pedidos             (empresa_id, cliente_id nullable)
 │   └─ pedido_itens    (pedido_id, produto_id nullable — snapshot, ver §7)
 ├─ transacoes          (empresa_id, pedido_id nullable, comanda_id nullable)
 ├─ auditoria           (empresa_id, usuario_id nullable)
 ├─ integracoes         (empresa_id) — chave logica (empresa_id,tipo)
 ├─ mesas               (empresa_id, comanda_id nullable — mesa "aponta" pra comanda aberta)
 │   └─ comandas        (empresa_id, mesa_id, cliente_id nullable)
 │       ├─ comanda_itens   (comanda_id, produto_id nullable — snapshot, ver §8)
 │       └─ pagamentos      (comanda_id nullable, pedido_id nullable — ver §9)
 ├─ conversas           (empresa_id, cliente_id nullable)
 │   └─ mensagens       (conversa_id)
 └─ webhook_events      (empresa_id — nao FK real, so string)
```

**Ciclo mesa↔comanda:** `mesas.comanda_id` aponta pra comanda aberta; `comandas.mesa_id` aponta de volta. Isso é uma referência mútua opcional (ambos nullable) — em Postgres, ambas as FKs podem ser `deferrable` ou simplesmente `on delete set null`, sem problema real de ciclo já que nenhuma é `not null`.

**Pedido criado por comanda:** quando uma comanda fecha, gera um `pedido` com `comanda_id` preenchido — isso é uma FK opcional de `pedidos` para `comandas` que **não existe na tabela `pedidos` do Supabase hoje** (a coluna não está no schema atual, só é usada pelo Mongo).

---

## 7. Estratégia de `pedido_itens`

**Decisão já tomada** (sessão anterior): tabela relacional, não JSONB, com
snapshot histórico completo por item.

**Gap real encontrado nesta auditoria:** o Mongo atual só grava
`{produto_id, nome, preco, quantidade}` por item — sem `id`, `desconto`,
`observacao` ou `subtotal`. A tabela `pedido_itens` já existente no Supabase
também não tem `desconto`, `observacao` nem `created_at`. Ambos (dado real e
schema existente) precisam ser estendidos para bater com a decisão.

**Plano:**
- Migration nova (não editar `0001_init.sql`, que já pode ter rodado em
  algum ambiente): `alter table pedido_itens add column desconto numeric(12,2) not null default 0, add column observacao text default '', add column subtotal numeric(12,2), add column created_at timestamptz not null default now()`.
- `subtotal` calculado no Service no momento da escrita (`preco*quantidade - desconto`), nunca via trigger/coluna gerada, para respeitar a decisão #2. Considerar `numeric` gerado por aplicação, não `generated always as`.
- Migração de dados: para cada item existente no array `pedido.itens`, gerar `id` novo (`gen_random_uuid()`), `desconto=0`, `observacao=''`, `subtotal=preco*quantidade`, `created_at=pedido.created_at` (não existe timestamp por item no Mongo, herda do pedido pai).
- `pedido_itens.preco` já é `numeric(12,2) not null default 0` sem FK para `produtos.preco` — já está correto quanto a **nunca recalcular a partir do preço atual do produto** (schema já é a favor da decisão, só faltam colunas).
- **Achado de risco**: `POST /pedidos` aceita itens do cliente sem validar formato — o Service (route.js ou seu sucessor) precisa continuar sendo o único ponto que valida `produto_id`/`nome`/`preco` antes de persistir; a tabela relacional não substitui essa validação.

---

## 8. Estratégia de `comanda_itens`

**Decisão já tomada:** tabela relacional (`comanda_itens`), mesma lógica de
`pedido_itens`.

**Gap real:** tabela não existe no Supabase hoje (não estava nem nos
"módulos futuros" comentados em `0001_init.sql` corretamente — comandas já é
módulo ativo, o comentário está desatualizado). Mongo grava
`{id, produto_id, nome, preco, quantidade, observacao, operador_id, operador_nome, created_at}` — **tem `id` e `observacao`, mas não tem `desconto` nem `subtotal`** (mesmo gap de `pedido_itens`).

**Achado de inconsistência de dados (já sinalizado na auditoria Fase 1,
reconfirmado agora):** os itens de comanda criados pelo **seed** (`seedEmpresa()`,
array `itensDemo`) **não têm o campo `id`** — só os itens criados via
`POST /comandas/:id/itens` em produção têm `id` (gerado por `uuidv4()` no
Service). Isso significa que qualquer empresa criada só com dados de seed e
nunca usada de verdade pode ter itens de comanda sem `id` no banco.
**Migração precisa gerar `id` para esses itens também**, não presumir que
todo item já tem um.

**Plano:**
- Nova tabela `comanda_itens`: `id uuid pk, empresa_id, comanda_id, produto_id nullable, nome, preco, quantidade, desconto default 0, observacao default '', subtotal, operador_id nullable, operador_nome nullable, created_at`.
- `operador_id`/`operador_nome` viram colunas nullable — no Mongo sempre existem porque quem adiciona item está autenticado, mas o schema deve permitir null pra não quebrar se um dia o item vier de outro fluxo (ex.: import).
- Migração de dados: gerar `id` para itens sem ele; `subtotal = preco*quantidade - desconto` (desconto sempre 0 pois não existe hoje); demais campos copiados diretamente.

---

## 9. Estratégia de pagamentos

**Achado de duplicação de dado (já flagado na Fase 1, ainda presente):**
`comanda.pagamentos[]` é uma cópia denormalizada de um subconjunto dos campos
que também vivem na coleção/tabela `pagamentos`. No Postgres isso **não deve
ser replicado** — a tabela `pagamentos` (nome sugerido: manter `pagamentos`,
já que é o nome real da coleção; `PagamentoRegistro` é só o nome do tipo
TypeScript para não colidir com o enum `Pagamento`) é a única fonte de
verdade, e o total pago por comanda é uma **query** (`sum(valor) where
comanda_id=... and status='approved'`), não uma coluna sincronizada.

**Plano:**
- Nova tabela `pagamentos`: `id, empresa_id, comanda_id nullable (fk comandas), pedido_id nullable (fk pedidos), metodo text, valor numeric(12,2), status text check (status in ('pending','approved','rejected','cancelled','refunded','unknown')), provider text check (provider in ('manual','mercadopago')), provider_payment_id text nullable, external_reference text nullable, idempotency_key text not null, qr_code text nullable, qr_code_base64 text nullable, ticket_url text nullable, created_at, updated_at`.
- `unique (idempotency_key)` — hoje o Mongo não tem essa constraint; é gerado com `uuidv4()` sempre único na prática, mas nada garante isso no banco. Adicionar a constraint é uma melhoria de integridade sem mudar comportamento (nunca haveria colisão real).
- `pago`/`restante` de uma comanda continuam sendo **calculados pelo Service** (`computeComanda()` ou seu equivalente), nunca persistidos como coluna sincronizada via trigger — mantém a decisão #2. Se performance exigir cache, isso é decisão para depois da Fase 4, documentada explicitamente, não default.
- Migração de dados: cada documento de `pagamentos` vira uma linha. O array `comanda.pagamentos[]` **não migra para lugar nenhum** — é só descartado, pois é 100% redundante com a coleção `pagamentos` (validar com contagem: nº de pagamentos por comanda no array deve bater com nº de linhas em `pagamentos` com aquele `comanda_id`, exceto se algum pagamento tiver sido criado antes de existir a coleção separada — não deveria ser o caso, mas validar).

---

## 10. Estratégia de `webhook_events`

**Achado de risco (Fase 1, reconfirmado):** não existe unique constraint real
sobre `eventKey` no Mongo — o dedupe depende só da combinação
`updateOne(...,{upsert:true})` + checar `upsertedCount`, que é
funcionalmente correto no Mongo (upsert é atômico), mas **não tem uma
constraint de banco a favor**, só convenção de código.

**Plano:**
- Tabela `webhook_events`: `id uuid pk default gen_random_uuid(), event_key text not null unique, empresa_id uuid not null, provider text not null, received_at timestamptz not null default now()`.
- **Não é uma entidade de domínio** — não precisa de RLS de tenant igual às outras (é só plumbing técnico), mas pode ganhar RLS por `empresa_id` de qualquer forma por consistência/defesa em profundidade.
- Sem repository dedicado (mantém o padrão atual — é infraestrutura, não domínio), mas se a Fase 4 criar um `SupabaseWebhookEventsHelper` fino só para o `upsert`, tudo bem, não é obrigatório ter um `Repository<T>` completo aqui.
- Migração de dados: **não há necessidade de migrar `webhook_events` histórico** — é um log técnico de deduplicação, não tem valor de negócio retroativo. Pode começar vazio no Supabase.

---

## 11. Estratégia de conversas/mensagens

- `conversas`: tabela nova, `status check (status in ('ABERTA','AGUARDANDO_EQUIPE','AGUARDANDO_CLIENTE','RESOLVIDA'))`, `cliente_id` fk nullable, `pedido_ativo_id` **não deveria ser uma FK enforced** — no Mongo é só uma referência solta (`b.pedido_ativo_id` aceito sem validar que o pedido existe), então ou vira `uuid nullable` sem FK, ou vira FK com `on delete set null` (mais seguro, recomendado, sem mudar comportamento visível).
- `mensagens`: tabela nova, append-only (sem policy de update/delete além do owner via service role), `operador_id` nullable (mensagens inbound não têm), `tipo` inclui `'conversation'` como valor legítimo (não é bug, é o `messageType` bruto da Evolution API para texto simples — **não normalizar para `'text'` na migração**, preservar o valor original).
- **Achado de segurança já conhecido, não resolvido por esta migração:** o webhook `/whatsapp/webhook?tenant=<empresa_id>` não tem nenhuma verificação de assinatura/segredo — qualquer um que descubra o `empresa_id` (UUID, difícil de adivinhar, mas não é secreto) pode injetar mensagens/clientes/conversas falsas nesse tenant. Migrar para Supabase não muda isso; é um problema de aplicação, não de banco. Fica registrado como risco a resolver separadamente (fora do escopo desta migração de dados).
- Índice recomendado: `conversas(empresa_id, contato_numero)` (usado no webhook para achar/criar conversa) e `conversas(empresa_id, ultima_mensagem_em desc)` (usado no `list()` ordenado); `mensagens(empresa_id, conversa_id, created_at)`.

---

## 12. Estratégia de Auth

**Sem mudança de recomendação desde a auditoria Fase 1** — só reforçando
com mais detalhe agora que o resto do código foi relido:

- Decisão já tomada: migrar para Supabase Auth (não é o caminho de menor
  risco, mas foi a escolha explícita do usuário).
- **Ainda não tem auditoria própria.** Pontos que essa auditoria futura
  precisa cobrir, identificados nesta releitura:
  1. `usuarios.senha_hash` (formato `salt:scryptHash`) não tem conversão
     possível para o hash que o Supabase Auth usa — não dá pra "migrar" a
     senha, só resetar ou pedir que o usuário redefina no primeiro login
     pós-migração.
  2. `verifyToken()`/`signToken()` usam JWT HMAC caseiro com claims
     `{usuario_id, empresa_id, papel, iat, exp}` — o token do Supabase Auth
     tem formato e claims diferentes (`sub`, etc.); qualquer lugar que hoje
     lê `session.empresa_id`/`session.papel` direto do payload precisa de
     um mapeamento (provavelmente via `app_metadata`/`user_metadata` do
     Supabase Auth, ou uma tabela de perfil separada — a própria
     `public.usuarios` já pressupõe isso com `id = auth.users.id`).
  3. **`usuarios.email` é único globalmente, não por tenant** — isso é uma
     regra de produto existente (uma pessoa só pode ter uma empresa por
     e-mail). Supabase Auth por padrão também trata e-mail como identificador
     único global do projeto todo, então isso **bate naturalmente**, não é
     um obstáculo — só precisa ser preservado conscientemente, não
     alterado achando que "cada tenant deveria ter seu próprio espaço de
     e-mail".
  4. RBAC (`papel`) não é gerenciado pelo Supabase Auth nativamente — precisa
     continuar em `public.usuarios.papel` (ou mover para
     `app_metadata`, com trade-offs de sincronização).
- **Recomendação de sequenciamento:** não bloquear a Fase 4 (schema de
  persistência) esperando a auditoria de Auth. São mudanças ortogonais —
  dá para ter Supabase Postgres com JWT local ainda por um tempo (assim como
  o Mongo funciona hoje), e trocar Auth depois, como uma Fase separada.

---

## 13. Estratégia de RLS

- **Situação atual:** RLS habilitada só nas 9 tabelas que já existem;
  depende de `auth.uid()`, que só existe numa sessão Supabase Auth real.
  Enquanto o backend usar `getSupabaseAdmin()` (service role key, que
  ignora RLS) com JWT local, a RLS fica **adormecida** — o isolamento real
  continua sendo 100% responsabilidade do código da aplicação (idêntico ao
  Mongo hoje, onde não existe RLS nenhuma).
- **Decisão a manter (recomendada na Fase 1, ainda válida):** aceitar RLS
  como defesa-em-profundidade teórica por enquanto, documentar isso
  explicitamente no código/README para não criar falsa sensação de
  segurança, e não bloquear a Fase 4 por isso.
- **Trabalho necessário na Fase 4, independente da decisão de Auth:**
  estender a policy padrão "tenant" (`policies_rls.sql`, o loop `do $$
  ... foreach t in array [...]`) para incluir `mesas, comandas,
  comanda_itens, pagamentos, conversas, mensagens`. `webhook_events` pode
  entrar na mesma policy por consistência, mesmo não sendo entidade de
  domínio.
- Nenhuma policy nova de tipo diferente é necessária — todas as 6 tabelas
  novas seguem o mesmo padrão "isolamento total por `empresa_id`" das
  demais, exceto `usuarios` (que já tem uma policy especial restringindo
  escrita a OWNER/ADMIN — não se aplica a nenhuma tabela nova).

---

## 14. Estratégia de índices

Índices que já existem no Mongo (via `ensureIndexes()`) e devem ter
equivalente no Postgres:

| Mongo (`ensureIndexes()`) | Postgres equivalente |
|---|---|
| `usuarios{email:1}` unique | já existe (`usuarios.email unique`) |
| `usuarios{empresa_id:1}` | já existe |
| `{empresa_id:1}` em categorias/produtos/clientes/pedidos/transacoes/auditoria/integracoes | já existe em todas |
| `{empresa_id:1}` em mesas/comandas/pagamentos/webhook_events/conversas/mensagens | **faltam** (tabelas não existem ainda) |
| `empresas{slug:1}` unique | já existe |

Índices adicionais recomendados que o Mongo **não tem** mas o padrão de
acesso real pede (encontrados lendo os métodos dos repositories):

- `mesas(empresa_id, numero)` — usado para achar/ordenar por número; considerar `unique (empresa_id, numero)` também (ver §11 sobre numeração não-atômica — ver riscos).
- `comandas(empresa_id, status)` — usado em `GET /comandas?status=`.
- `comandas(empresa_id, mesa_id)` — usado no join do `GET /mesas`.
- `pagamentos(empresa_id, comanda_id)` e `pagamentos(provider, provider_payment_id)` — usado no webhook do Mercado Pago (`findByProviderPaymentId`) e no resync de status.
- `conversas(empresa_id, contato_numero)` e `conversas(empresa_id, ultima_mensagem_em desc)`.
- `mensagens(empresa_id, conversa_id, created_at)`.
- `pedido_itens(pedido_id)` — já existe.
- `comanda_itens(comanda_id)` — nova, mesmo padrão.

---

## 15. Estratégia de migração de dados

1. **Pré-requisito:** Fase 4 (schema) completa e validada em ambiente de
   staging Supabase antes de qualquer dado real ser copiado.
2. **Ordem de carga por empresa** (respeita FKs): `empresas → usuarios →
   categorias → produtos → clientes → pedidos → pedido_itens → transacoes →
   integracoes → mesas → comandas → comanda_itens → pagamentos → conversas →
   mensagens → auditoria`. `webhook_events` não migra (começa vazio, §10).
   `papeis`/`permissoes` já têm seed próprio, não migram do Mongo.
3. **IDs:** ambos os lados já usam UUID string — **sem remapeamento de
   chave**, migração é 1:1 por `id`.
4. **Transformações obrigatórias** (não é cópia direta):
   - `pedido_itens`/`comanda_itens`: gerar `id` (quando ausente),
     `desconto=0`, `observacao=''` (quando ausente), `subtotal =
     preco*quantidade - desconto` calculado no momento da migração.
   - `comanda.pagamentos[]`: descartar (dado duplicado, ver §9).
   - `empresas.config`: copiar como jsonb direto — já é compatível.
   - Datas: Mongo `Date` → `timestamptz` direto, sem timezone shift (ambos
     UTC internamente).
5. **Transação por empresa:** cada empresa migra dentro de uma transação
   Postgres — tudo ou nada por tenant, permite retomar empresa por empresa
   se algo falhar no meio, sem deixar tenants pela metade.
6. **Idempotência:** script de migração faz upsert por `id`, pode rodar de
   novo com segurança após corrigir um bug, sem duplicar dado.
7. **Corte/janela:** como os ledgers (`transacoes`, `pagamentos`, `mensagens`,
   `auditoria`) são append-only e continuam recebendo escrita real até o
   corte, ou (a) uma janela curta de manutenção no Mongo durante a
   migração final, ou (b) uma segunda passada delta (só documentos com
   `created_at`/`data` depois do timestamp da primeira cópia).

---

## 16. Estratégia de validação

Depois de cada carga (staging e produção), validar por empresa:

- **Contagem:** nº de documentos Mongo == nº de linhas Postgres, por
  coleção/tabela.
- **Somas financeiras:** soma de `transacoes.valor` por `tipo` (receita/
  despesa) idêntica dos dois lados; soma de `pagamentos.valor` por `status`
  idêntica.
- **Amostragem de cálculo:** pegar N comandas fechadas aleatórias, rodar
  `computeComanda()`-equivalente em cima dos dados migrados e comparar
  com os valores `subtotal/desconto_valor/taxa_valor/total/pago/restante`
  que já estavam persistidos no Mongo — devem bater exatamente (mesma
  fórmula, dados idênticos).
- **Isolamento multi-tenant:** depois de migrar 2+ empresas, confirmar que
  nenhuma query com `empresa_id=A` retorna linha de `empresa_id=B` (o mesmo
  teste que `backend_test.py` já faz no Mongo, repetir contra Postgres).
- **Regra crítica "concluir pedido → receita":** para uma amostra de
  pedidos com `status in ('concluido','ENTREGUE')`, confirmar que existe
  exatamente uma transação de receita vinculada (`pedido_id`) — tanto no
  Mongo (fonte) quanto no Postgres (destino).
- **Suite de testes:** rodar `backend_test.py`/`_v2`/`_v3` inteiras contra o
  backend apontando pro Postgres (exige que a Fase 5 — trocar os
  `Mongo*Repository` por `Supabase*Repository` — já tenha um switch
  `DATABASE_PROVIDER` funcional). Baseline de comparação: os números atuais
  (v1 40/40, v2 39/39, v3 32/33).

---

## 17. Estratégia de rollback

- Migração é **aditiva do lado Postgres e só-leitura do lado Mongo** — o
  script de migração nunca apaga nem altera dado no Mongo.
- Rollback = manter `DATABASE_PROVIDER=mongo` (ou nunca trocar) — instantâneo,
  sem perda, já que o Mongo continua sendo a fonte de verdade até a troca
  ser confirmada estável.
- Se o corte de produção já tiver acontecido e precisar reverter: como
  nada foi apagado do Mongo, reverter é só trocar a env var de volta — mas
  **qualquer escrita feita já em Postgres depois do corte seria perdida**
  ao voltar pro Mongo. Por isso a recomendação é: período de
  paralelismo/observação antes de considerar o corte "definitivo e
  irreversível", ou aceitar explicitamente que reverter depois de X tempo
  tem custo de dado.
- Manter os dois schemas (Mongo e Postgres) compatíveis em formato (mesmos
  IDs, mesmos campos) pelo tempo que durar o paralelismo, para que um script
  de "replay de diferenças" seja viável se necessário.

---

## 18. Riscos

Ordenados por impacto, não por probabilidade:

1. **Contradição já existente entre `triggers.sql` e a decisão #2** (§4) —
   os triggers de regra de negócio já escritos (`pedido_recalc_total`,
   `pedido_on_conclusao`) precisam ser removidos/revisados antes da Fase 4
   avançar, ou a Fase 4 herda uma arquitetura que o próprio usuário já
   rejeitou explicitamente.
2. **Dado real incompleto em relação ao schema-alvo**: itens de pedido/
   comanda sem `id`/`desconto`/`subtotal` hoje — a migração de dados
   precisa sintetizar esses campos, não presumir que já existem (§7, §8).
3. **Numeração de `pedido.numero`/`mesa.numero` não-atômica** — já existe
   no Mongo (`countDocuments()+1` e `max()+1`), o trigger Postgres
   `pedidos_set_numero()` **reproduz o mesmo problema** em vez de corrigi-lo.
   Sob concorrência real (dois pedidos criados ao mesmo tempo), pode gerar
   número duplicado, o que colide com o `unique(empresa_id, numero)` já
   existente e causaria erro 500 em vez de um número errado (na verdade
   isso é uma melhoria silenciosa: hoje o Mongo aceitaria o duplicado sem
   constraint; o Postgres rejeitaria — mudança de comportamento observável
   sob concorrência, vale decidir conscientemente antes da Fase 4).
4. **RLS adormecida** pode ser lida erroneamente como "já protegido" por
   quem não souber que o service role key ignora RLS — precisa de nota
   explícita na documentação de arquitetura (`docs/ARCHITECTURE.md`) quando
   a Fase 4 acontecer.
5. **Auth desacoplado do resto** — decisão de ir para Supabase Auth ainda
   sem plano de migração de senha; se isso não for resolvido antes do corte
   de produção, usuários existentes ficam sem conseguir logar.
6. **Webhook do WhatsApp sem assinatura** — pré-existente, não é causado
   pela migração, mas é uma boa oportunidade de corrigir já que o schema
   está sendo revisado de qualquer forma (fora do escopo formal desta
   migração, mas vale registrar para decisão do usuário).
7. **`pedido.itens` sem validação de schema** — `POST /pedidos` aceita
   formato livre do cliente; ao normalizar para tabela relacional, um
   payload malformado (sem `produto_id`/`nome`) que hoje só gera um
   documento "estranho" no Mongo passaria a poder violar `not null`
   constraints no Postgres e quebrar a request com 500 em vez de salvar
   silenciosamente errado. Tecnicamente uma melhoria, mas é uma mudança de
   comportamento visível (erro em vez de dado ruim salvo) — vale confirmar
   que é aceitável.
8. **Dual-write `comanda.pagamentos[]` vs coleção `pagamentos`** — se por
   algum motivo os dois já estiverem dessincronizados em produção (bug
   silencioso hoje, nunca verificado), a migração vai descartar o array e
   ficar só com a coleção separada — isso é o comportamento correto pela
   decisão de design, mas **vale rodar a validação de contagem do §16 antes
   de descartar**, para garantir que não existe pagamento só no array e
   ausente da coleção.

---

## 19. Ordem recomendada das próximas fases

1. **Fase 3.5 (higiene, antes da Fase 4):** revisar `supabase/triggers.sql`
   à luz da decisão #2 — remover ou reescrever `pedido_recalc_total()` e
   `pedido_on_conclusao()` para não conter regra de negócio. Decidir
   conscientemente sobre `pedidos_set_numero()` (manter a mesma limitação
   do Mongo, ou corrigir para uma sequence real — mudança de escopo,
   requer aprovação). Atualizar o comentário desatualizado em
   `0001_init.sql` que lista "mesas, comandas" como módulos futuros.
2. **Fase 4 — Schema Supabase:** criar as migrations que faltam (6 tabelas
   novas + `comanda_itens` + alterações em `empresas`/`usuarios`/
   `transacoes`/`integracoes`/`pedido_itens`) e estender RLS/índices
   conforme §13/§14. Sem dado real ainda, só schema, testável isoladamente.
3. **Fase 5 — `Supabase*Repository`:** implementar as 16 classes
   `Supabase*Repository` satisfazendo os mesmos contratos de
   `packages/domain/src/index.ts` já usados pelos `Mongo*Repository` — sem
   tocar em `route.js` ainda além de um switch `DATABASE_PROVIDER`.
4. **Fase 6 — Migração de dados:** script de migração (§15), rodado
   primeiro em staging com dados clonados/sintéticos, validado (§16) antes
   de tocar em dado de produção.
5. **Fase 7 — Testes com `DATABASE_PROVIDER=supabase`:** suíte completa
   (`backend_test*.py`) rodando contra Postgres em staging, baseline
   idêntico ao Mongo.
6. **Fase 8 — Auditoria de Auth + implementação Supabase Auth** — pode
   correr em paralelo às Fases 4-7 (é ortogonal à persistência), mas o
   corte de produção final deve esperar as duas trilhas estarem prontas.
7. **Fase 9 — Corte de produção:** com janela de paralelismo/observação
   (§17) antes de desligar o Mongo definitivamente.
8. **Fase 10 — Realtime** (mensagens/conversas/pedidos) — só depois de
   tudo acima estável, conforme já estava na sequência original do usuário.

---

## 20. Definition of Done da migração

A migração MongoDB → Supabase só pode ser considerada concluída quando:

- [ ] Todas as 15 tabelas de domínio existem no Supabase com schema
      validado contra este documento (§3).
- [ ] `triggers.sql` não contém nenhuma regra de negócio (só integridade/
      mecânica) — revisado explicitamente contra a decisão #2.
- [ ] RLS habilitada e testada nas 15 tabelas de domínio.
- [ ] Todos os 16 `Supabase*Repository` implementados, satisfazendo os
      mesmos contratos que os `Mongo*Repository` já satisfazem hoje.
- [ ] `DATABASE_PROVIDER` funcional, com os dois providers testados lado a
      lado.
- [ ] Dados de todas as empresas migrados e validados (§16) — contagens,
      somas financeiras e amostras de cálculo batendo exatamente.
- [ ] `backend_test.py`/`_v2`/`_v3` passando 100% idêntico ao baseline
      Mongo rodando contra `DATABASE_PROVIDER=supabase`.
- [ ] Multi-tenancy revalidada explicitamente em Postgres (isolamento
      cross-empresa).
- [ ] Regra crítica "concluir pedido/fechar comanda → receita" revalidada
      em Postgres, cobrindo `'concluido'` E `'ENTREGUE'`.
- [ ] Auth migrado (ou decisão explícita e documentada de adiar, com JWT
      local convivendo intencionalmente por mais tempo).
- [ ] Estratégia de rollback testada de verdade (não só documentada) em
      staging antes do corte de produção.
- [ ] `HANDOFF.md`, `docs/ARCHITECTURE.md` e a memória do projeto
      atualizados refletindo Supabase como banco oficial.
- [ ] MongoDB mantido como fallback só até confirmação de estabilidade
      (prazo definido pelo usuário), depois desligado.

---

## Revisão do próprio documento (autocrítica)

Reli as 20 seções contra os 40 itens de verificação pedidos e contra o
código relido. Pontos que faltavam e foram adicionados durante esta
revisão:

- **RBAC via `papeis`/`permissoes`** (itens 25/26 da lista): inicialmente
  eu ia tratar como "já coberto pela Fase 1", mas ao reler `route.js` linha
  a linha confirmei que essas tabelas **nunca são lidas** — é um achado que
  não estava explícito no documento até esta revisão. Adicionado em §2 e §3.
- **Trigger `pedido_recalc_total`/`pedido_on_conclusao` já contradizem a
  decisão #2** (item 34, regras de receita): esse é o achado mais
  importante do documento inteiro e quase ficou só implícito em "estratégia
  de migração" — promovido a uma fase própria (Fase 3.5, §19) e a um risco
  de topo (§18.1), porque bloqueia a Fase 4 se não for resolvido antes.
- **Itens de comanda do seed sem `id`** (item 17, comanda_itens): eu sabia
  disso da Fase 1, mas na primeira versão deste documento eu tinha escrito
  a estratégia de `comanda_itens` presumindo que só "alguns" itens
  precisariam de `id` sintético. Corrigido para deixar claro que é
  qualquer comanda nascida de seed, não um caso raro.
- **`usuarios`/`categorias`/`produtos`/`clientes` nunca setam `updated_at`
  no Mongo**, mas o trigger Postgres já existente vai passar a setar
  automaticamente: adicionei essa observação em §2 e §4 porque é uma
  mudança de comportamento observável (campo que era sempre ausente passa
  a ser sempre preenchido) que eu não tinha registrado explicitamente na
  primeira passada.
- **Item 39/40 (testes existentes / test_result.md)**: confirmei que a
  suíte de testes atual (`backend_test*.py`) testa contra o comportamento
  do Mongo, não teria como pegar automaticamente uma regressão específica
  do Postgres (ex.: um trigger disparando duas vezes) até que a Fase 7
  rode a mesma suíte contra Postgres — por isso "rodar a suíte contra
  `DATABASE_PROVIDER=supabase`" é um item do Definition of Done, não uma
  suposição de que "os testes já cobrem isso".

Não encontrei, nesta revisão, nenhuma entidade, coleção ou regra de negócio
citada nos itens 1-40 do pedido que não tenha sido endereçada em alguma
seção acima. Os itens 31/32 (seeds/dados demo) estão cobertos em §2 (onde
o seed é a fonte dos exemplos de campo) e §15 (seed não migra, tem script
próprio já existente em `seed.sql` para o catálogo RBAC).
