# Fase 3.5 — Limpeza de Triggers de Negócio no Supabase

Fase intermediária da migração MongoDB → Supabase, entre a Fase 3
(extração dos repositories Mongo, concluída) e a Fase 4 (schema Supabase,
ainda não iniciada). Escopo estrito: corrigir a contradição arquitetural
identificada em `docs/plans/MONGO-TO-SUPABASE-AUDIT.md` (seção 4) antes de
qualquer trabalho novo de schema. **Nenhuma tabela nova, nenhum repository
Supabase, nenhuma migração de dado e nenhuma troca de runtime foram feitos
nesta fase.**

**Data:** 2026-08-10

## Problema encontrado

`supabase/triggers.sql` continha duas triggers que implementavam **regra de
negócio dentro do banco**, escritas antes da decisão explícita do dono do
projeto de que regra de negócio (cálculo de totais, transições de status,
geração de receita) fica exclusivamente no Service, nunca em trigger. Essa
contradição já estava registrada como o achado mais importante da auditoria
anterior e bloqueava o início consciente da Fase 4.

## Busca realizada (antes de qualquer alteração)

`grep` recursivo em todo o repositório por `pedido_recalc_total`,
`pedido_on_conclusao`, `pedidos_set_numero`, `set_updated_at` e pelos nomes
de trigger (`trg_itens_total`, `trg_pedido_conclusao`, `trg_pedidos_numero`,
`trg_*_updated`).

**Resultado:** essas funções/triggers só são referenciadas em
`supabase/triggers.sql` (onde são definidas) e no documento de auditoria
anterior (`docs/plans/MONGO-TO-SUPABASE-AUDIT.md`, onde foram citadas como
achado). **Nenhuma migration, seed, policy RLS, teste (`backend_test*.py`,
`test_result.md`) ou outro trecho de documentação faz referência a elas.**
Isso confirma que era seguro remover sem quebrar nada que dependesse
explicitamente desses nomes — nenhum código de aplicação nunca rodou contra
essas triggers (o schema Supabase nunca foi ativado como runtime).

## Triggers identificadas e classificação

| Trigger/função | Classificação | Motivo |
|---|---|---|
| `set_updated_at()` + `trg_*_updated` (empresas, usuarios, categorias, produtos, clientes, pedidos, integracoes) | **Mecânica — mantida** | Só seta um timestamp; não decide nada sobre o domínio. |
| `pedidos_set_numero()` + `trg_pedidos_numero` | **Mecânica — mantida** | Atribui um inteiro sequencial (equivalente a uma sequence por tenant); não calcula nem decide nada de negócio. Não-atômica sob concorrência (mesma limitação já existente no runtime Mongo hoje, via `countDocuments()+1`) — risco pré-existente, não introduzido nem corrigido nesta fase, já registrado na auditoria. A proteção contra duplicidade real já existe como **constraint** (`unique (empresa_id, numero)` em `0001_init.sql`), não como trigger — exatamente a abordagem que o item 7 da tarefa pediu para preferir, e ela já estava lá desde a Fase 1. |
| `pedido_recalc_total()` + `trg_itens_total` | **Regra de negócio — removida** | Recalculava `pedidos.total` a partir da soma de `pedido_itens` a cada insert/update/delete de item. "Cálculo de total" é explicitamente listado como responsabilidade do Service. |
| `pedido_on_conclusao()` + `trg_pedido_conclusao` | **Regra de negócio — removida** | Gerava uma transação de receita e incrementava `total_pedidos`/`total_gasto` do cliente ao `status` mudar para `'concluido'`. "Geração de receita" e "transição de status" são explicitamente responsabilidade do Service. |

## Dependências verificadas (item 4 da tarefa)

Verificado especificamente contra o código real (`app/api/[[...path]]/route.js`,
runtime atual) que a regra de negócio equivalente já existe, correta e
completa, **fora do banco**, e cobre todos os casos que a trigger removida
cobria — e mais:

- **Status `'concluido'`**: `PUT /pedidos/:id` — `finais.includes(b.status)` inclui `'concluido'`. Cobre o caso que a trigger cobria.
- **Status `'ENTREGUE'`**: mesmo bloco — `finais = ['concluido', 'ENTREGUE']`. **A trigger removida nunca cobriu este caso** (só reagia a `'concluido'`); o Service em Mongo já cobre os dois desde a v3. Ou seja, remover a trigger não perde funcionalidade nenhuma que o runtime atual dependa — pelo contrário, a trigger já estava desatualizada em relação ao Service há pelo menos uma versão inteira do produto.
- **Geração de receita**: `transacaoRepo.create({...tipo:'receita', categoria:'Vendas', descricao:'Pedido #'+numero, valor:pedido.total, pedido_id, data, created_at})` — mesma forma de registro que a trigger fazia via `insert into transacoes`.
- **Cálculo de total**: `POST /pedidos` calcula `total = round(sum(preco*quantidade))` antes de persistir; `POST /comandas/:id/fechar` usa `computeComanda(comanda).total`. Nenhum dos dois depende de recálculo pelo banco — o valor já chega pronto no `insert`/`update`.
- **Pedidos de delivery**: usam o mesmo campo `status` e o mesmo bloco `finais.includes(...)` — sem tratamento especial, mesma regra.
- **Pedidos originados do atendimento WhatsApp**: a Central de Atendimento não cria pedidos diretamente (só referencia `pedido_ativo_id` numa conversa); pedidos em si continuam nascendo de `POST /pedidos` ou do fechamento de comanda — ambos já cobertos acima.
- **Pedidos originados de comandas**: `POST /comandas/:id/fechar` cria o pedido com `status:'concluido'` **e já cria a transação de receita explicitamente no mesmo Service**, sem nunca ter dependido da trigger (a trigger só existia no schema Supabase, que nunca foi o runtime ativo).

**Conclusão da verificação:** a regra de negócio nunca dependeu da trigger em nenhum momento de uso real, porque o runtime sempre foi MongoDB. A trigger era código morto do ponto de vista de execução, mas viva do ponto de vista de "o que a próxima pessoa vai copiar/ativar sem perceber a contradição" — daí o risco real que motivou esta fase.

## Alterações realizadas

1. **`supabase/triggers.sql`**: removidas as funções `pedido_recalc_total()`
   e `pedido_on_conclusao()` e seus respectivos triggers (`trg_itens_total`,
   `trg_pedido_conclusao`), substituídas por um bloco de comentário
   explicando o que foi removido, por quê, e onde essa responsabilidade
   passa a viver documentadamente (Service, nas fases futuras de
   persistência Supabase). Adicionados `drop trigger if exists`/
   `drop function if exists` idempotentes para o caso deste script já ter
   sido executado contra algum banco antes desta correção. `pedidos_set_numero()`
   recebeu um comentário explicando por que foi mantida (mecânica) e
   apontando para a constraint de unicidade já existente.
2. **`docs/ARCHITECTURE.md`**: adicionado **ADR-006 — Regras de negócio
   pertencem exclusivamente ao Service**, declarando explicitamente a
   divisão de responsabilidade (Service: regra de negócio; Postgres:
   integridade e automação mecânica) e registrando o histórico desta
   limpeza para que a próxima pessoa não reintroduza o mesmo padrão.
3. **Este documento** (`docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md`), criado.

Nenhuma migration nova foi criada. `0001_init.sql`, `policies_rls.sql` e
`seed.sql` não foram tocados (as constraints/índices necessários já
existiam desde a Fase 1). Nenhuma tabela nova. Nenhum `Supabase*Repository`
implementado. Nenhuma linha de `app/api/[[...path]]/route.js` ou de
`lib/repositories/mongo/*` foi alterada — o runtime MongoDB continua
idêntico ao final da Fase 3.

## Triggers mantidas e justificativa

- `set_updated_at()` (+ 7 triggers que a usam): mecânica, sem regra de negócio.
- `pedidos_set_numero()`: mecânica (numeração), com a ressalva de não-atomicidade já documentada na auditoria e não corrigida aqui (fora de escopo desta fase — corrigir isso é uma decisão de schema/design para a Fase 4, não uma limpeza de regra de negócio indevida).

## Triggers removidas e justificativa

- `pedido_recalc_total()` / `trg_itens_total`: calculava total — regra de negócio.
- `pedido_on_conclusao()` / `trg_pedido_conclusao`: gerava receita e atualizava métricas — regra de negócio, e incompleta (só `'concluido'`, nunca `'ENTREGUE'`).

## Impacto

**Nenhum impacto no runtime atual.** O schema Supabase nunca esteve
conectado a nenhum ambiente ativo do produto (Fase 4 ainda não começou);
esta limpeza altera só arquivos `.sql` e documentação. O impacto real é
para o **futuro**: quando a Fase 5/6 implementar `SupabasePedidoRepository`
e a migração de dados, o Service que orquestra esse repository (ainda a ser
escrito) precisará, ele mesmo, computar `pedidos.total` e disparar a
criação da transação de receita para `status in ('concluido', 'ENTREGUE')`
— exatamente como o `route.js` atual já faz para o Mongo. Isso já está
registrado como requisito explícito no comentário deixado em
`supabase/triggers.sql` e neste documento, para não ser esquecido.

## Testes executados

Suíte completa `backend_test.py` / `backend_test_v2.py` / `backend_test_v3.py`
rodada contra o ambiente local (MongoDB via Docker, runtime inalterado)
após a alteração:

| Suíte | Resultado | Baseline (antes desta fase) |
|---|---|---|
| v1 | 40/40 passando, 0 falhas, 0 críticas | 40/40 |
| v2 | 39/39 passando, 0 falhas, 0 críticas | 39/39 |
| v3 | 32/33 passando, 1 falha conhecida | 32/33 |

A única falha em v3 é a inconsistência já documentada em `test_result.md`
(`tipo:'conversation'` em vez de `'text'` no webhook do WhatsApp —
comportamento correto da Evolution API, não é bug, não é regressão).
**Resultado idêntico ao baseline, como esperado** — esta fase não altera
nenhum código que os testes exercitam (eles testam a API contra MongoDB;
o arquivo alterado é SQL do Supabase, nunca executado neste ambiente).

## Resultado

Fase 3.5 concluída. `supabase/triggers.sql` não contém mais nenhuma trigger
que execute regra de negócio sem justificativa por escrito — revisão final
confirmou que restam só `set_updated_at` (mecânica) e `pedidos_set_numero`
(mecânica, com ressalva documentada). A contradição que bloqueava o início
consciente da Fase 4 está resolvida.

## Riscos restantes (não resolvidos nesta fase, propositalmente fora de escopo)

- `pedidos_set_numero()` continua não-atômica sob concorrência real — decisão de corrigir (ex.: sequence real por tenant) fica para quando a Fase 4 desenhar o schema definitivo, não é uma limpeza de regra de negócio.
- Nenhuma tabela nova foi criada — as 6 tabelas que faltam (`mesas`, `comandas`, `comanda_itens`, `pagamentos`, `webhook_events`, `conversas`, `mensagens`) continuam pendentes da Fase 4, junto com as colunas/constraints faltando em `empresas`/`usuarios`/`transacoes`/`integracoes`/`pedido_itens` já listadas na auditoria.
- A auditoria de Auth (Supabase Auth) continua pendente, sem relação com esta fase.

## Próximo passo recomendado

Iniciar a **Fase 4** (criar o schema Supabase que falta, conforme
`docs/plans/MONGO-TO-SUPABASE-AUDIT.md` seções 3, 7, 8, 9, 10, 11, 13, 14),
agora sem a contradição arquitetural que esta fase resolveu. Aguardando
aprovação explícita antes de iniciar, conforme instruído.
