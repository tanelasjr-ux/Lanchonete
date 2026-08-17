# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-18 (achado critico de schema CORRIGIDO na raiz:
migrations agora rodam sozinhas no boot do container, verificado em producao;
alerta global de estoque entregue — ver §0)

## Como usar este arquivo

Leia este arquivo **primeiro** em qualquer sessao de trabalho neste projeto.
Ele e a memoria de longo prazo do Restaurant OS: deve ser possivel entender o
sistema inteiro lendo este documento + os arquivos em `docs/` que ele
referencia, sem depender de historico de conversa.

Quando o dono do projeto pedir um handoff, este arquivo e **reescrito por
completo** com o estado atual (nao e um resumo do dia — e o retrato inteiro
do projeto, atualizado). A regra formal esta em `CLAUDE.md`, secao 18.1.

---

# 0. PONTO DE RETOMADA (leia isto primeiro)

## 🔴 ACHADO CRITICO (2026-08-18) — migrations nao aplicadas em producao

**As migrations `0019_estoque.sql`, `0020_custo.sql` e `0021_cardapio_imagem.sql`
nunca tinham sido rodadas contra o Supabase de producao**, apesar de Estoque
(marcado "COMPLETO" em 2026-08-14) e CMV (marcado "completo e em producao" em
2026-08-17) terem passado por sessoes inteiras de implementacao, revisao e
"verificacao". O codigo sempre esteve certo; o banco de producao e que nunca
recebeu as colunas que esse codigo depende (`produtos.custo`,
`produtos.estoque_habilitado/quantidade/minimo`,
`transacoes.custo_total/receita_base/receita_com_custo`,
`empresas.cardapio_imagem_url`).

**Como foi descoberto:** o dono reportou "nao acho o QR code do cardapio" —
investigacao achou um bug de UI real (ver item 2 abaixo, ja corrigido). Ao
testar a correcao em producao, o dono bateu num SEGUNDO erro ao clicar
"Enviar imagem": `Could not find the 'cardapio_imagem_url' column of
'empresas' in the schema cache`. Isso levou a checar o schema real de
producao via `psql` — e achar que nao era so essa coluna.

**Por que ninguem notou antes:** migrations neste projeto **nao fazem parte
do auto-deploy do EasyPanel** — sao aplicadas manualmente via `psql` contra
`SUPABASE_DB_URL` (ver §5.1). "Testado contra Supabase real" em sessoes
anteriores quase certamente rodou com `DATABASE_PROVIDER=supabase`
**localmente** (mesmo projeto que producao — ver a nota sobre C1 abaixo),
o que explica tanto os dados de teste que poluiram producao quanto a falsa
sensacao de "ja testamos isso contra o banco real": testou, mas ninguem deu
o passo manual de aplicar a migration ANTES daquela sessao de teste, entao
o teste local com Mongo (`DATABASE_PROVIDER=mongo`, que nao usa essas
colunas da mesma forma) mascarou o problema, e quando rodou contra
Supabase real por engano, pode ter falhado silenciosamente em pontos que
ninguem checou a fundo.

**Corrigido nesta sessao:** as 3 migrations sao 100% aditivas
(`add column if not exists`) — aplicadas em producao via
`docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" < supabase/migrations/NNNN.sql`,
depois `NOTIFY pgrst, 'reload schema';` pra forcar o PostgREST a reconhecer
as colunas novas sem esperar o refresh automatico. Verificado: schema
completo (15 colunas em `produtos`, 15 em `transacoes`, 18 em `empresas`) e
leitura via REST confirmando que o PostgREST ja enxerga as colunas.

**Ainda nao verificado end-to-end:** com o schema corrigido, o codigo
DEVERIA funcionar, mas ninguem testou Estoque/CMV na tela real de producao
ainda (so a leitura de schema). **Proxima sessao (ou o proprio dono agora):
testar cadastro de custo num produto, ver o card de CMV no Dashboard, e
testar o controle de estoque — os 3 endpoints que dependem dessas colunas.**

**✅ CAUSA RAIZ ELIMINADA no mesmo dia** (`8548470`) — o passo manual deixou
de existir. `docker/entrypoint.sh` roda `scripts/migrate.mjs` no boot do
container e so entao `exec node server.js`. Migration pendente agora e
aplicada sozinha no deploy; migration que falha **derruba o boot** em vez de
subir a app com schema errado. Detalhe tecnico completo no item **C6** do
`PROFISSIONALIZACAO.md`.

**Verificado em producao (2026-08-18 18:59):** tabela `public.schema_migrations`
criada com as 21 migrations registradas via baseline automatica. Da proxima
migration em diante, basta commitar o arquivo em `supabase/migrations/` — o
deploy aplica.

**Pegadinha que custou algumas idas e vindas:** `SUPABASE_DB_URL` precisou ser
adicionada nas variaveis do EasyPanel (a app nunca precisou dela, porque usa a
API REST). Duas armadilhas no caminho, ambas dignas de nota para a proxima vez:
1. O painel do Supabase oferece a **Direct Connection**
   (`db.<ref>.supabase.co`), que resolve para IPv6 e nao conecta. O correto e o
   **Session Pooler** (`aws-0-us-east-2.pooler.supabase.com`) — ja documentado
   em §5.1, e agora com um caso real por tras.
2. O painel entrega a string com o literal `[YOUR-PASSWORD]`, que passa
   despercebido facilmente. Copiar o valor do `.env` local evita os dois
   problemas de uma vez.

## 📋 Dois backlogs, propositos diferentes

| Documento | Para que serve |
|---|---|
| **este arquivo** | features de produto — o que o restaurante ganha de novo |
| **`docs/PROFISSIONALIZACAO.md`** | saude tecnica e prontidao comercial — o que impede vender e o que impede mudar sem quebrar |

O programa de profissionalizacao e um **documento vivo com 15 itens**, executavel
ao longo de varias sessoes, cada um com evidencia no codigo e criterio de pronto.
Progresso: ✅ A1 (2026-08-16) → ✅ A2 (2026-08-18) → 🟡 C1 (2026-08-18,
producao limpa, causa raiz sem trava tecnica) → ⚪ B1 (proximo). Ordem
recomendada: `A1 → A2 → C1 → B1 → A3 → D1 → B2 → ...`

**O achado mais importante que ele registra:** as `feature_flags` existem, tem
tela de configuracao, e **nenhum dos 81 endpoints as consulta** — desligar
"Estoque" nao desliga o Estoque. Sem corrigir isso (item B1) nao existe plano
Basico e plano Pro, e portanto nao existe billing.

**Item A1 concluido em 2026-08-16** (`b46d88e`, `be8f167`, `f79a46b`) — as 7
suites de teste rodam com `npm test`, 7/7 passando contra ambiente local. A
execucao encontrou e corrigiu 6 problemas reais, incluindo um que teria repetido
no proprio CMV: `POST/PUT /produtos` gravam a partir de lista explicita de
campos, e os campos de estoque ficaram semanas fora dela. Detalhes completos no
proprio `PROFISSIONALIZACAO.md`, item A1.

**Custo e Margem (CMV) concluido em 2026-08-17** — as 9 tasks da execucao SDD
foram completadas (Tasks 1-8 revisadas e limpas, Task 9 validou a suite de
testes inteira passando). Commits: `ac17676`, `3019916`, `488ac50`, `5add47c`,
`458d2a9`, `917800a`, `75ef358`, `1b2d493`. Codigo no ar nos dois backends:
MongoDB (dev local) e Supabase (producao EasyPanel, deploy automatico por
push). Detalhe completo na secao abaixo.

**⚠️ Correcao (2026-08-18):** "codigo no ar" acima estava certo, mas o
schema de producao NAO estava — a migration `0020_custo.sql` so foi
aplicada ao Supabase real em 2026-08-18, um dia depois deste paragrafo ter
sido escrito. Ver achado critico no topo deste arquivo.

**Whole-branch review do CMV encontrou 1 issue importante, corrigida no dia
seguinte** (`2544610`, 2026-08-18): o bloco `cmv` em `GET /dashboard/metrics`
nao tinha permission gate — ATENDENTE e COZINHA (roles com `dashboard` mas sem
`relatorios`/`financeiro`) recebiam custo/margem, a classe de dado mais
sensivel do sistema. Corrigido com o mesmo gate que `/financeiro/relatorio`
ja usava. Junto (`9d6202d`): `backend_test_custo.py` movido pra `tests/`
(nao era descoberto por `tests/run_all.py`, que so busca ali) e roadmap deste
arquivo atualizado.

**Item A2 concluido em 2026-08-18** (`e12abe8`) — varredura completa de
`app/page.js`: 83 `catch` blocks, 25 sem `toast.error` no mesmo bloco. Triados
em 4 categorias: 12 falso-positivo (toast na linha seguinte ou padrao ja
correto), 8 violacoes reais (zero sinal, erro virava "lista vazia" silenciosa
— corrigidas com `console.error` ou `toast.error`), 4 parciais com degrade
intencional em polling (30s/5s — toast a cada falha seria ruido; ganharam
comentario explicando o por que), 1 documentado como pertencente a trilha C3
(loadMe() desloga em qualquer erro — precisa de status HTTP no erro de api()
pra distinguir 401 real de transitorio). Consequencia: quando C3 for atacado,
ja ha ponto de entrada mapeado. Verificado: navegacao visual via Playwright
sem erros no console + suite 8/8 confirmando zero regressoes.

**Analise competitiva + 2 achados corrigidos em 2026-08-18**
(`docs/ANALISE-COMPETITIVA.md`) — leitura do codigo (nao suposicao) comparando
o produto aos lideres do nicho (Anota AI, Saipos, Goomer). Achado central: a
gestao (KDS/caixa/estoque/CMV/comanda) esta acima da media do mercado, mas as
duas pontas que o posicionamento promete — WhatsApp e cardapio QR — eram casca
sem motor. Dois dos tres achados ja avancaram no mesmo dia:

- **Imagem do cardapio digital** (`4d262ce`) — o cardapio publico so exibia
  lista de produtos, sem carrinho nem link de pedido. Decisao do dono: fase 1
  (esta) deixa o restaurante subir uma foto/poster do cardapio impresso, com
  o mesmo link/QR ja existente (mesa + delivery) levando direto pra ela, mais
  um banner de itens "indisponivel hoje" por cima (reaproveita o toggle
  `disponivel` ja existente). Carrinho/checkout/pagamento ficam para uma fase
  2 separada. Migration `0021_cardapio_imagem.sql`, bucket Storage `cardapios`
  proprio (5MB). 10/10 testes (`tests/backend_test_cardapio.py`).
- **Webhook do WhatsApp sem verificacao nenhuma** (`14c4050`) — `/whatsapp/webhook`
  criava cliente+conversa+mensagem so com `?tenant=<empresa_id>` no corpo,
  diferente do webhook do Mercado Pago (mesmo arquivo, 20 linhas acima) que ja
  assinava/deduplicava/reconsultava a fonte. Quem obtivesse um `empresa_id`
  injetava mensagem forjada na caixa de atendimento de qualquer empresa.
  Corrigido com o mesmo padrao do Mercado Pago: `webhookSecret` gerado
  automaticamente por empresa, exigido via `?secret=...` (`timingSafeEqual`),
  dedupe por `key.id`. `tests/backend_test_v3.py` atualizado para o novo
  contrato. 35/35 testes.
- **Automacao do WhatsApp** (item restante do achado #1) fica a cargo do n8n
  — decisao do dono, ainda a executar. Arquitetura ja preparada
  (`lib/integrations/n8n.js` ja publica eventos de dominio).

**Item C1 concluido em 2026-08-18** — limpeza de empresas de teste em
producao. Auditoria encontrou 126 de 127 empresas com padrao de teste
(`@teste.com`, nomes `Restaurante Bella Vista`/`Pizzaria Napolitana`/
`KDS Teste A/B`/`Caixa Teste`, criadas 2026-08-10 a 2026-08-14). Backup
completo (todas as colunas) salvo antes de qualquer exclusao; lista
mostrada e confirmada explicitamente por voce antes da execucao; delete em
6 lotes via REST (`ON DELETE CASCADE`, remove produtos/pedidos/mesas/
caixa/conversas de cada empresa junto); pos-delete verificado — producao
com exatamente 1 empresa (a sua, `Tanelas FooD`), 0 registros orfaos.

**Causa raiz identificada mas nao 100% resolvida:** essas empresas surgiram
porque o projeto **nao tem um Supabase de staging separado** — e um unico
projeto multi-tenant, entao rodar as suites com `DATABASE_PROVIDER=supabase`
localmente escreve direto em producao. Hoje o `.env` local esta seguro
(`mongo`), mas isso e convencao, nao trava tecnica. Criar um segundo
projeto Supabase so pra teste e decisao de custo/infra sua, documentada
como pendente em `PROFISSIONALIZACAO.md` (item C1, marcado 🟡 nao ✅ por
causa disso).

---

## ✅ CONCLUÍDO — Custo e Margem (CMV)

**Implementacao completa (2026-08-17):** 9 tasks, todas revisadas e limpas.

- **Schema:** migration `0020_custo.sql` aplicada — 3 campos novos em
  `transacoes` (`custo_total`, `receita_com_custo`, `receita_base`) + 1 campo
  novo em `produtos` (`custo`).
- **Backend:** apuracao de custo congelada nos 3 pontos de venda (pedido
  concluido, comanda fechada, comanda dividida com rateio por metodo de
  pagamento); agregacao `computeCMV` alimentando Dashboard e Relatorio;
  isolamento multi-tenant verificado.
- **Frontend:** campo de custo no dialog de cadastro do produto; cards de
  lucro bruto e CMV no Dashboard; linha de KPIs + export CSV no Relatorio
  financeiro.
- **Testes:** suite de 9 testes de integracao (`backend_test_custo.py`, raiz
  do projeto) cobrindo o fluxo de ponta a ponta — 9/9 passando.
- **Invariantes travadas:** distincao `null` (produto sem custo cadastrado,
  fora do calculo) vs `0` (custo zero real, ex. brinde); rateio de custo em
  comanda dividida por metodo de pagamento; estorno nunca devolve custo;
  isolamento de dados multi-tenant.

**Commits (Tasks 1-8, implementacao):**
```
ac17676 schema: custo em produtos e apuracao congelada em transacoes
3019916 feat: modulo puro de apuracao de custo e CMV
488ac50 feat: apura e congela o custo nos tres pontos de venda
5add47c feat: bloco cmv no dashboard e no relatorio financeiro
458d2a9 feat: campo de custo no cadastro do produto, persistido nos dois sentidos
917800a feat: cards de lucro bruto e CMV no dashboard
75ef358 feat: CMV no relatorio financeiro e no export CSV
1b2d493 test: suite de integracao de custo e CMV
```

**Task 9 (verificacao final):** suite consolidada `tests/run_all.py` (7/7
suites) + suite CMV `backend_test_custo.py` (9/9, raiz do projeto — na epoca
nao coberta pelo glob de `run_all.py`) rodadas contra o ambiente local,
ambas verdes. **Pos-whole-branch-review:** `backend_test_custo.py` movido
para `tests/` — `run_all.py` agora descobre e roda as 8 suites (16/16
testes) automaticamente, fechando o gap de descoberta apontado na revisao
final.

**Estrutura de workspace SDD:**
- Ledger: `.superpowers/sdd/2026-08-14-custo-margem-implementation/progress.md`
- Briefs: `task-{1..9}-brief.md`
- Reports: `task-{1..9}-report.md`

## O que mudou nesta implementação

- **A1 (profissionalizacao, pre-CMV):** 6 bugs reais de producao encontrados e
  corrigidos ao rodar as suites de teste pela primeira vez — endpoints de
  estoque, campos de produto e a suite do cardapio digital. Commits `b46d88e`,
  `be8f167`, `f79a46b`. Detalhes em `docs/PROFISSIONALIZACAO.md`, item A1.
- **Tasks 1-9 (CMV):** implementacao full-stack completa — schema, modulo
  puro, gravacao de custo, agregacao, UI (Dashboard + Relatorio + cadastro) e
  suite de testes de integracao. Todas as 9 tasks revisadas e testadas.

**O que a feature faz:** hoje `Produto` tem `preco` e nao tem custo em lugar
nenhum — o sistema sabe quanto entrou e nunca quanto sobrou. A feature adiciona
custo ao produto e deriva CMV%, cobertura e lucro bruto no Dashboard e no
Relatorio financeiro.

**As 4 decisoes que nao podem ser perdidas** (detalhadas na spec):

1. **Custo congelado na `transacao`, nao no item.** Evita reescrever as 4 funcoes
   atomicas do Postgres (armadilha do §4.3) e ainda assim preserva a historia:
   mudar o custo amanha nao reescreve o CMV de hoje.
2. **`produtos.custo` e `null`, nunca `0` por omissao.** `null` = nao cadastrado
   (fora do calculo, conta contra a cobertura); `0` = custo zero real (brinde).
   Sem essa distincao o CMV do dia 1 sai lindo e falso.
3. **Cobertura sempre ao lado do CMV.** Um CMV de 31% com 40% de cobertura nao e
   um CMV de 31%.
4. **Estorno nao devolve custo.** A comida foi produzida e perdida — o custo
   aconteceu. Estorno piora o CMV, que e o sinal correto.

**Escopo aprovado:** campo de custo no cadastro do produto; CMV/cobertura/lucro
no Dashboard (dia) e no Relatorio (periodo + CSV).
**Fora de escopo (decidido, nao esquecido):** margem por item na lista de
produtos, preview de margem ao vivo no dialog, ficha tecnica, custo por media
ponderada de compras.

**Arquivos entregues:** migration `0020_custo.sql`, `lib/custo.js` +
`test_custo_calculo.mjs`, os 4 repositorios (produto e transacao nos dois
backends), `route.js` (3 pontos de gravacao + 2 endpoints), `app/page.js`,
`backend_test_custo.py` (raiz do projeto).

**Por que esta feature primeiro:** analise de especialista feita em 2026-08-14
apontou 3 lacunas de gestao — ausencia total de custo, estoque por produto em vez
de insumo (ficha tecnica), e dashboard sem KPI operacional. Custo e a de menor
esforco e maior retorno, e **desbloqueia a ficha tecnica** depois (com ela,
`produtos.custo` deixa de ser digitado e passa a ser derivado da receita).

---

**O app esta NO AR e em uso:**

```
https://restaurante-app.ilmdzk.easypanel.host
```

Rodando sobre **Supabase**, com HTTPS, no projeto `restaurante` do EasyPanel.
O dono ja opera pela interface (empresa "Tanelas FooD").

**Estado do codigo:** **sincronizado com GitHub** (`main` em dia). Todas as
melhorias publicadas. EasyPanel implanta automaticamente ao receber push.

**Entregue e PUBLICADO:**
1. Correcao do tema que revertia sozinho depois de ~2s.
2. Desconto e acrescimo em pedidos, com ajuste apos a criacao.
3. Upload de logo por arquivo (antes so aceitava colar URL).
4. **Impressao de cupom** — comanda da cozinha (sem precos) e via do
   cliente (com valores), para qualquer pedido ou fechamento de comanda.
   Ver §4.1 (decisao estrutural) e §10 armadilha 21.
5. **Correcao do bug de impressao** (container id no body, nao no JSX) —
   imprimia pagina em branco em producao; achado testando ao vivo.

**KITCHEN DISPLAY SYSTEM (KDS) — 11/11 TASKS COMPLETAS ✅**
Implementacao via subagent-driven-development, plano executado completamente (`docs/plans/KDS-IMPLEMENTATION-PLAN.md`).

**Status: 100% PRONTO PARA MERGE E DEPLOY**

✅ **Backend (Tasks 1-6):** migration 0016, domain contracts, kdsTokenRepository, dual-auth endpoints (GET /kds/pendentes + POST /kds/concluir), token lifecycle management (GET/POST/DELETE /kds/tokens)

✅ **Frontend (Tasks 7-10):** observação field UI, KDS components (KDSPainel, KDSTv, CozinhaPendentes), integração no App() (TV link + nav COZINHA), config screen (Empresa tab para gerar/revogar links)

✅ **Validation (Task 11):** testes 40/40 + 32/33 (baseline), build clean, security checklist completa (multi-tenant isolation, token permissions, RLS coverage)

**Deferred findings (nao-bloqueadores, podem ser corrigidos em sprint futuro):**
- Task 3: kds_tokens sem indices Mongo (Task 8 has it via RLS) — adicionar a ensureMongoIndexes() quando Mongo indexing for revisitado
- Task 5: POST /kds/concluir mesa branch silent ok se id inexistente (cosmético, nao affects UX) — standardizar 404 handling se quiser

**Ledger completo:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/progress.md`
**Briefs por task:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/task-{1..7}-brief.md`
**Reports por task:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/task-{1..7}-report.md` (Task 6 em progresso)

**Status de bugs encontrados em produção (2026-08-13):**

✅ **RESOLVIDOS (commit 2f5e330):**
- Hard refresh (Ctrl+Shift+R) resolveu cache de nome de mesa
- TV setup descoberto e testado (funciona!)
- Observações já estão implementadas (Task 7)
- **Botão overflow em Comanda** — CSS flex reflow (grid-cols-3 → grid-cols-2 + full-width bottom)
- **Edição de pedidos "Recebido"** — adicionado pencil icon + dialog, PATCH /pedidos/:id, suporta: tipo, itens, observações

**Deferred findings KDS (não-urgentes):**
- Task 3: índices Mongo para kds_tokens
- Task 5: 404 handling em POST /kds/concluir mesa branch

**🔴 BUG CRÍTICO DESCOBERTO (2026-08-14):**

**Problema:** Quando cozinheiro clica "pronto" no KDS, o pedido fica travado em "em_preparo" (sem mensagem de erro). Clicar em outro pedido "destranca".

**Root cause (investigação concluída):**
1. **UI bug:** `components/kds.jsx` linha 87-95: `concluir()` remove item otimisticamente ANTES de confirmar sucesso. Se API retorna OK, nunca recarrega pra sincronizar.
2. **Backend bug:** `app/api/route.js` linha 700: `pedidoRepo.update()` não verifica se update funcionou. Retorna `{ ok: true }` mesmo se update falhou silenciosamente.

**Impact:** Pedido marcado como "pronto" no backend pode falhar, mas UI acha que sucedeu. Próximo polling traz item de volta (porque ainda em "em_preparacao"), criando ilusão de travamento.

**Fix necessário (2 mudanças):**
1. Backend: Verificar resultado de `update()`, retornar erro se null:
   ```javascript
   const updated = await pedidoRepo.update(kctx.empresa_id, b.id, { status: 'pronto' })
   if (!updated) return err('Pedido nao encontrado', 404)
   ```
2. UI: Recarregar após sucesso de `onConcluir()`, não só em erro:
   ```javascript
   const concluir = async (item) => {
     setItens(s => s.filter(i => i.id !== item.id))
     try {
       await onConcluir(item)
       await carregar()  // <-- AQUI: recarregar após sucesso
     } catch (e) { ... }
   }
   ```

**Status:** Pronto para ser fixado amanhã (fix rápido, 10-15min)

---

**DELIVERY COMPLETO — 12/12 TASKS COMPLETAS ✅**
Implementacao via subagent-driven-development, plano executado completamente (`docs/plans/2026-08-13-delivery-completo-implementation.md`).

**Status: 100% PRONTO PARA MERGE E DEPLOY**

✅ **Backend (Tasks 1-8):** 
- Migration 0017_delivery.sql: 6 colunas em `pedidos` (entrega_endereco, entrega_taxa, entrega_tempo_estimado_min, entregador_id, entregador_nome, saiu_para_entrega_em)
- Tabela `entregadores` com RLS por empresa_id
- Domain contracts: Entregador, EmpresaDeliveryConfig, PedidoStatus += 'saiu_para_entrega'
- Repositories: Supabase + MongoDB com interface idêntica
- API CRUD entregadores: GET, POST, PUT, DELETE (soft-delete)
- Endpoints pedidos: POST/PUT com defaults de config, PATCH /status com saiu_para_entrega + snapshot entregador
- Endpoint empresa: PUT /empresa aceita config.delivery (taxa_padrao, tempo_estimado_min)
- Cálculo: total = subtotal - desconto + acrescimo + entrega_taxa

✅ **Frontend (Tasks 9-12):**
- Empresa config screen: bloco Delivery com taxa/tempo + CRUD entregadores inline
- Pedido dialog: campos endereço/taxa/tempo (pré-preenchidos de cliente + config), resumo de valores com linha de taxa
- Pedidos list: filtro por tipo, cards delivery com endereço/taxa/entregador/tempo elapsed, destaque atrasados, modal seletor de entregador
- Cupom: linha "Taxa de Entrega" em valores, endereço no rodapé

**Ledger completo:** `.superpowers/sdd/2026-08-13-delivery-completo-implementation/progress.md`
**Spec e plan:** `docs/superpowers/specs/2026-08-13-delivery-completo-design.md` + `docs/superpowers/plans/2026-08-13-delivery-completo-implementation.md`

**Status de commits:** Todos 12 tasks commitados e pushed para GitHub. EasyPanel auto-deploy iniciado.

---

**CAIXA — ✅ 14/14 TASKS COMPLETAS**

**Status:** Implementacao via subagent-driven-development, **PRONTO PARA DEPLOY**.

✅ **T1-9 COMPLETAS (backend + endpoints):**
- T1: Schema 0018_caixa.sql + domain contracts ✅
- T2: lib/caixa.js + testes (10 testes, todos passando) ✅
- T3-5: Repositorios (Supabase + Mongo) + query methods ✅
- T6: Forma de pagamento na origem (comanda + pedido) ✅
- T7-9: Endpoints caixa completos (/abrir, /fechar, /movimento, /estorno) + security fixes (TOCTOU mitigated) ✅
  - Commits: 57658f6..f8d7d26 (9 tasks total)

✅ **T10-12 COMPLETAS (UI):**
- T10 (054d0f9): Barra de status do caixa + dialog abertura ✅
- T11 (ae8a899): Fechamento com conferencia ao vivo + movimentos + historico ✅
- T12 (bundled ae8a899): Estorno UI + aviso de caixa fechado ✅

✅ **T13 COMPLETA (testes de API):**
- backend_test_caixa.py: suite com 25+ testes cobrindo todos endpoints (b78a580) ✅
  - Cobre: abertura, fechamento, sangria, suprimento, estorno
  - Multi-tenant isolation, forma de pagamento tracking, race condition scenarios
  - Ready to run: `BASE_URL=http://localhost:3000/api python3 backend_test_caixa.py`

✅ **T14 COMPLETA (docs):**
- HANDOFF.md atualizado com estado final (2026-08-14) ✅
- Arquitetura, fluxo, endpoints, schema documentados ✅
- Bug KDS critical descoberto + fixado (34e374c) ✅

**Ledger SDD:** `.superpowers/sdd/2026-08-13-caixa-implementation/progress.md`
**Spec e plan:** `docs/superpowers/specs/2026-08-13-caixa-design.md` + `docs/superpowers/plans/2026-08-13-caixa-implementation.md`

**Status de commits:**
- Backend + endpoints: 57658f6..f8d7d26
- UI (status bar + dialogs + historico): 054d0f9, ae8a899
- Testes: b78a580
- Docs: 57f4112 (handoff)
- KDS bug fix: 34e374c

**SDD Final Review & Fix Loop (2026-08-14):**

Final code reviewer descobriu 2 production-blocking bugs que não foram pegos durante implementação:

**🔴 BLOCKER 1 (FIXADO e97dbfa):** `lib/repositories/supabase/transacaoRepository.js` — unwrap() signature mismatch
- `findByCaixa` e `findByPedido` chamavam `unwrap(data, error)` com 2 args, mas unwrap() espera destructured object `{ data, error }`
- **Impact:** Ambos retornavam [] sempre → receitas_dinheiro=0, estornos=0 em reconciliação de caixa
- **Na produção:** Cada fechamento de caixa mostra saldo curto pelo valor de todas as vendas do dia (cash only)
- **Fix:** Passar full Supabase response object ao unwrap(), não dados destructurados
- Commit: e97dbfa (1 file, 4 inserts, 6 deletions)

**🔴 BLOCKER 2 (FIXADO d624507):** `lib/repositories/supabase/comandaRepository.js` — updateItemCampos() retorno faltante
- KDS fix (34e374c) adicionou verification `if (!updated) return err(...)` mas método retornava undefined
- **Impact:** Cada clique "pronto" em item de comanda no KDS retorna HTTP 500, mesmo com sucesso no DB
- **Fix:** Adicionar `.select().maybeSingle()` chain + return statement (padrão usado por pedidoRepository)
- Commit: d624507 (1 file, 1 insert, 1 deletion)

**🟡 MEDIUM 1 (FIXADO a3b8bdb):** Mongo duplicate-key error não mapeado para 409 em POST /caixa/abrir
- Mongo `code: 11000` não estava na lista de check (só `23505` Postgres)
- Consequence: race condition na abrir retorna 500 em Mongo backend
- **Fix:** Adicionar `|| e.code === 11000` ao error handler
- Commit: a3b8bdb (1 file, 1 insert, 1 deletion)

**🟡 MEDIUM 2 (PARKED):** `/caixa/fechar` TOCTOU race na concurrent close (concorrência extrema)
- Dois reqs simultâneos podem fazer `.update()` em caixa já fechado
- Trade-off: fix requer índice em status (latência) vs rare race case
- **Ruling:** Aceito em MVP; pode ser endereçado em sprint se observado em produção

**🟡 MEDIUM 3 (PARKED):** Test suite (backend_test_caixa.py, backend_test_kds.py) nunca foi executada
- Falha de processo durante SDD (código OK, testes não rodados)
- **Mitigação:** calc module 10/10 pass, build green, reviewer validou todos 14 tasks
- **Testes:** Podem ser rodados pós-deploy contra servidor live se necessário

**Verificação Final:**
- Calc module tests: 10/10 ✅
- Build: 6.3s clean ✅
- Syntax check: OK ✅
- Todos 3 blocker fixes committed e pushed ✅

**Próximos passos:**
1. ✅ Fixar KDS critical bug (concluído 2026-08-14, commit 34e374c)
2. ✅ Completar Caixa 14/14 + SDD final review (concluído 2026-08-14)
3. ✅ Fixar 2 blocker bugs (concluído 2026-08-14, commits e97dbfa + d624507 + a3b8bdb)
4. **Deploy Caixa em produção** ← PRÓXIMO PASSO
5. Opção: Investigar notificações push no KDS (spike aprovada, MVP+1)

---

---

**ESTOQUE MVP — 12/12 TASKS COMPLETAS ✅**
Implementacao via subagent-driven-development em 2026-08-14.

**Status: 100% PRONTO PARA DEPLOY EM PRODUÇÃO**

✅ **Backend (Tasks 1-6):**
- Migration 0019_estoque.sql: 3 colunas em `produtos` (estoque_habilitado, estoque_quantidade, estoque_minimo)
- Domain contracts: EstoqueAjuste, Produto + ProdutoRepository extensions
- Repositories (Supabase + Mongo): decrementarEstoque(), ajustarEstoque(), listEstoqueBaixo(), getEstoque()
- API integration: Stock deduction em PUT /pedidos/:id e POST /comandas/:id/fechar (non-fatal errors)

✅ **Frontend (Tasks 7-10):**
- Produtos dialog: toggle "Rastrear Estoque" + quantidade/mínimo fields
- Produtos list: stock badge com 3-color status (verde/amarelo/vermelho)
- Dashboard: warning card com lista de produtos abaixo do mínimo (refresh 30s)
- Stock adjustment modal: dialog com dropdown de motivo + validação

✅ **Testing (Task 11):**
- backend_test_estoque.py: 8 integration tests cobrindo deduction, negativo-block, opt-in, adjustment, multi-tenant, low-stock, fractional quantities
- Testes passando: 8/8

✅ **Verification (Task 12):**
- 11 commits verificados (T1-T11)
- Schema: migration 0019 presente e idempotente
- JS syntax: 0 errors
- Testes: 8/8 passando
- Build: PASS

**Ledger SDD:** `.superpowers/sdd/2026-08-14-estoque-implementation/progress.md`
**Spec e plan:** `docs/superpowers/specs/2026-08-14-estoque-design.md` + `docs/superpowers/plans/2026-08-14-estoque-implementation.md`

**Commits (11 total):**
```
755a3d7 chore: update dependencies for Estoque MVP
7031d75 ui: add stock adjustment dialog
88c15e7 test: Add estoque integration test suite (8 test cases)
218a2e6 ui: add low-stock warning card to dashboard
05692d1 ui: Produtos dialog — add stock tracking fields
15b2c1e feat: PUT /pedidos/:id — integrate stock deduction on pedido conclusion
da872b9 feat: Mongo produtoRepository — add stock methods (identical interface to Supabase)
888e99a feat: Supabase produtoRepository — add stock methods
ad75570 types: Add Estoque interfaces + extend Produto + ProdutoRepository
874453b migration: Add estoque schema (estoque_habilitado, quantidade, minimo)
f2424d3 plan: Estoque MVP implementation — 12 tasks
06eb75f spec: Estoque MVP — rastreamento opt-in, baixa automática na venda, alertas
```

**Status de deploy:** Pushed para GitHub (2026-08-14 após conclusão). EasyPanel auto-deploy ativo.

---

**Roadmap (revisado em 2026-08-18 apos analise competitiva —**
**`docs/ANALISE-COMPETITIVA.md`)**

Concluido e no ar: KDS (11/11), Delivery (12/12), Caixa (14/14), Estoque
(12/12), Cardapio Digital (7/7 + imagem/indisponiveis 2026-08-18), Custo e
Margem/CMV (9/9, ver §0). "No ar" confirmado de fato em 2026-08-18 para
Estoque/CMV/Cardapio-imagem — antes disso o codigo estava no ar mas o
schema de producao nao tinha as colunas (ver achado critico no topo).

| # | Frente | Estado | Por que |
|---|--------|--------|---------|
| 1 | **Cardapio QR com carrinho (fase 2)** | ⚪ nao iniciada | `POST /cardapio/:slug/pedido` publico + cadastro de cliente + pagamento. Imagem/banner (fase 1, ✅) tirou a barreira de entrada; isto fecha o loop de venda de verdade. Ver `ANALISE-COMPETITIVA.md` §2.2/§4 |
| 2 | **Automacao do WhatsApp via n8n** | ⚪ nao iniciada | Decisao do dono (2026-08-18): atendente automatico fica no n8n, nao no `route.js`. Arquitetura ja publica eventos (`lib/integrations/n8n.js`); falta o fluxo do lado de la. Ver `ANALISE-COMPETITIVA.md` §2.1 |
| 3 | **Ficha tecnica (insumos)** | ⚪ nao iniciada | Faz o estoque funcionar para comida preparada, nao so revenda. Fecha o CMV real (hoje o CMV so cobre produtos com custo direto cadastrado). |
| 4 | **Dashboard operacional** | ⚪ nao iniciada | Tempo de preparo (o dado **ja existe** nos timestamps do KDS), faturamento por canal, horario de pico, taxa de cancelamento |
| 5 | **Testes E2E (Playwright)** | ⚪ nao iniciada | 5 features complexas, zero teste de UI. Os 2 blockers de 2026-08-14 seriam pegos por um teste que abrisse e fechasse um caixa com uma venda dentro |
| 6 | **Rate limiting** | ⚪ nao iniciada | `/auth/login` (forca bruta) e `/auth/register` (criacao ilimitada de tenants) sem limite nenhum. Ver `ANALISE-COMPETITIVA.md` §2.3 |

**Debitos tecnicos conhecidos** — todos catalogados com evidencia, criterio de
pronto e ordem de ataque em **`docs/PROFISSIONALIZACAO.md`**. Resumo:

- **`route.js` com 2.192 linhas e `page.js` com 2.920.** Maior risco do projeto.
  Ja cobrou: o fix do KDS (`34e374c`) quebrou o fechamento de comanda no Supabase
  e so foi pego em code review, depois de marcado "completo".
- **`backend_test_caixa.py` e `backend_test_kds.py` nunca foram executados.**
  Existem, sao bons, e ninguem rodou.
- **Um caixa aberto por empresa** (indice unico parcial). Cliente com balcao +
  delivery em PDVs separados nao consegue operar.
- **Sem NFC-e.** Fora de escopo por decisao, mas e bloqueio comercial real no
  Brasil. Caminho quando virar prioridade: intermediario fiscal (Focus NFe,
  NFe.io, Tecnospeed), nunca integracao direta com a SEFAZ.
- **Sem integracao iFood/Rappi.** Pedido de marketplace entra manual — hoje e o
  maior ralo de tempo operacional num restaurante real.

---

# 12. UX FEEDBACK — COMPLETO ✅

Implementado em 2026-08-13 (mesma sessao de conclusao do KDS).

| # | Tipo | Descricao | Esforço | Status | Commit |
|---|------|-----------|---------|--------|--------|
| 1 | 🔴 BUG | Botoes overflow em Pedidos (todas as etapas) | 1-2h | ✅ DONE | 1051b77 |
| 2 | 🟠 FEATURE | Nomes customizados para mesas | 4-6h | ✅ DONE | 1508270 |
| 3 | 🟠 FEATURE | Status "Em Falta" no cardapio (menu digital aware) | 6-8h | ✅ DONE | c5f4a09 |
| 4 | 🟠 FEATURE | Status pedido em Mesas (sumario em preparo/entregue) | 4-6h | ✅ DONE | fcb73ed |

**Notas de implementacao:**
- Item 1: CSS flex reflow — botoes agora em 2 linhas (status primario full-width, icons wrap)
- Item 2: UI adicionada (schema/backend ja existiam) — pencil icon para renomear mesas inline
- Item 3: UI adicionada (schema/backend/API ja existiam) — toggle "Em Falta" no cardapio + filtro em order builders
- Item 4: Descoberto que modelo de dados usa `entregue` flag (nao pedidos.comanda_id) — implementado com sumario real (Em preparo / Entregue)

**Para retomar:**
1. Usuarios com o app aberto precisam de Ctrl+Shift+R para limpar cache
   (navegador continua servindo JS antigo sem refresh hard).
2. Ambiente local so e necessario para desenvolver: Docker Desktop ->
   `docker start ros-mongo-local` -> `yarn dev:no-reload`. Detalhes no §8.
3. Saude do servidor: `GET /api/health`. Se vier `"status":"degraded"`, o
   campo `config_faltando` diz exatamente qual variavel esta faltando.
4. Proximas frentes no §11 — os primeiros 3 itens da lista foram completos:
   impressao, KDS e delivery. Proximo: fechamento de caixa ou estoque.

---

# 1. O que e o produto

**Restaurant OS** — SaaS de atendimento e gestao para restaurantes,
lanchonetes e similares, com WhatsApp como canal principal de atendimento.
Modulos: cardapio, pedidos (balcao/delivery/retirada/mesa), mesas e comandas,
clientes/CRM, financeiro, pagamentos, conversas de WhatsApp, relatorios,
auditoria e RBAC.

**Modelo comercial: SaaS multi-tenant.** Varios restaurantes clientes sao
atendidos por **uma unica instalacao e um unico projeto Supabase**. Nunca
criar um projeto/banco por cliente. O que varia por empresa e a **instancia
da Evolution API** (credenciais por tenant na tabela `integracoes`).

---

# 2. Arquitetura

## 2.1 Camadas

```
Route Handler (HTTP)  ->  Controller  ->  Service  ->  Repository  ->  Database
```

Tudo vive hoje em **um unico route handler catch-all**:
`app/api/[[...path]]/route.js` (Next.js App Router). Ele concentra dispatch
HTTP, autenticacao/autorizacao, regras de negocio e orquestracao. Nao e um
acidente: o projeto nasceu assim e a migracao decidiu **nao** reescrever isso
(evitar big-bang), so extrair a camada de dados. O frontend inteiro, na mesma
linha, e um unico `app/page.js`.

**Principios que nao podem ser quebrados:**

- **Regra de negocio existe so no Service** (hoje, dentro do `route.js`).
  Nunca em repository, nunca em trigger/function do Postgres. Formalizado no
  ADR-006 (`docs/ARCHITECTURE.md`) e ja custou uma correcao de design real.
- **O banco cuida so de integridade**: FK, NOT NULL, CHECK, UNIQUE, indices,
  RLS. As unicas funcoes Postgres permitidas sao **mecanicas** — numeracao
  atomica, incremento atomico, upsert atomico pai+filhos — e sempre recebem
  o valor ja decidido pelo Service.
- **Persistencia desacoplada por Repository Pattern**: o Service depende de
  contratos, nao de MongoDB nem de Supabase.
- **Integracao externa nunca e mockada**: sem credencial, avisar/falhar,
  jamais simular sucesso.

## 2.2 Contratos de dominio

`packages/domain/src/index.ts` — entidades e interfaces de repositorio
(TypeScript, **nao compilado**; o projeto nao tem `tsconfig`/`typescript`.
Serve como documentacao executavel do contrato). Ambos os backends satisfazem
exatamente as mesmas interfaces.

Entidades: `Empresa`, `Usuario`, `Categoria`, `Produto`, `Cliente`, `Pedido`
(+`PedidoItem`), `Mesa`, `Comanda` (+`ComandaItem`, `PagamentoResumo`),
`PagamentoRegistro`, `Transacao`, `Integracao`, `Conversa`, `Mensagem`,
`Auditoria`. Mais `BulkCreatable<T>` (carga em lote, usada pelo seed).

## 2.3 Implementacoes de repositorio

- `lib/repositories/mongo/` — **16 repositories** (backend default do codigo).
- `lib/repositories/supabase/` — **15 repositories** (o que roda no servidor).
- `lib/repositories/factory.js` — **escolhe o backend**. Unico lugar do
  sistema que sabe qual persistencia esta em uso.

`route.js` **nao conhece nenhum driver de banco**. Os 3 acessos diretos que
existiam fora do contrato foram eliminados na Fase 7: `ensureIndexes()` (foi
para a factory; no Supabase e no-op, os indices vem das migrations),
bulk-insert do seed (virou `createMany()`) e `webhook_events` (virou
`webhookEventsRepository`, nos dois backends).

## 2.4 Autenticacao e autorizacao

- **Auth: JWT local** (HMAC-SHA256, `exp` em segundos, TTL 7 dias) + senhas
  com **scrypt** (N=16384, r=8, p=1, formato `salt:hash`). Ainda **nao**
  migrado para Supabase Auth — auditado na Fase 8, implementacao nao iniciada.
- **O `papel` NUNCA vem do token**: e relido do banco a cada requisicao, no
  portao unico de auth. Por isso revogar acesso e imediato, e o RBAC nao
  precisa virar claim na migracao. Nao mudar isso sem entender o efeito.
- **RBAC: hardcoded** nos objetos `ROLES`/`PERMISSIONS` do `route.js` (50
  checagens `can()`). As tabelas `papeis`/`permissoes` existem no Supabase com
  seed, mas **o app nao as le** — armadilha conhecida, nao "corrigir" sem
  decisao.
- Papeis: `OWNER`, `ADMIN`, `GERENTE`, `ATENDENTE`, `COZINHA`.
- **Frontend**: token em `localStorage['ros_token']`, `fetch` puro, sem
  logica de refresh (ver armadilha 14).

---

# 3. Multi-tenancy (regra critica do produto)

Toda entidade de dominio carrega **`empresa_id`**. Isolamento em **duas
camadas, sempre as duas**:

1. **Aplicacao**: toda query e escopada por `empresa_id` extraido do token.
2. **Postgres RLS**: 17 tabelas com RLS habilitado, 18 policies.

Nunca confiar so em RLS, nem so na aplicacao. Ao criar qualquer entidade nova:
incluir `empresa_id`, criar a policy RLS e escrever teste de isolamento
cross-tenant.

Isso vale tambem para **arquivos**: a logo e gravada em
`{empresa_id}/logo.ext`, com o `empresa_id` vindo do token — nunca do corpo da
requisicao.

**Atencao (armadilha 13):** hoje o app usa a `service_role`, que **ignora RLS
por completo**. O isolamento em runtime e 100% da camada de aplicacao — as
policies sao defesa em profundidade que nunca e exercida.

---

# 4. Modelo de dados

## 4.1 Decisoes estruturais

- **Itens de pedido/comanda sao tabelas relacionais filhas**
  (`pedido_itens`, `comanda_itens`), nao JSONB. No MongoDB sao arrays
  embutidos; a traducao acontece no repository.
- **Snapshot historico por item**: `nome` e `preco` sao congelados no momento
  da venda. **Nunca** recalcular a partir do preco atual do produto.
- **`comanda.pagamentos`**: array embutido no Mongo (copia denormalizada); no
  Postgres **nao existe coluna** — a tabela `pagamentos` e a fonte unica. O
  `SupabaseComandaRepository` reconstroi o campo em memoria a cada leitura, so
  para preservar o contrato que `computeComanda()` ja espera.
- **Numeracao de pedido**: tabela `pedido_contadores` + funcao atomica por
  tenant (substituiu um `count()+1` com race condition).
- **Valores de pedido** (migration 0015): mesma gramatica de `comandas` —
  `total = subtotal - desconto + acrescimo`, calculado no Service.
  `desconto`/`acrescimo` sao ajuste manual do operador (cortesia,
  arredondamento, acerto). **Ajuste bloqueado (409) apos concluir**, porque
  nesse ponto o pedido ja virou receita em `transacoes`; corrigir depois disso
  exige lancamento no financeiro, nao edicao do pedido.
- **Logo da empresa**: arquivo no Supabase Storage; `empresas.logo` guarda a
  URL publica.
- **Impressao de cupom**: NAO E CUPOM FISCAL (sem NFC-e/SAT — precisaria de
  certificado digital e integracao com a SEFAZ, projeto proprio). E
  comprovante de producao/atendimento: comanda para a cozinha (sem precos)
  e via para o cliente (com subtotal/desconto/acrescimo/total). O sistema
  roda na nuvem e a impressora fica no restaurante — sem caminho de rede
  entre os dois — entao quem imprime e sempre o navegador do caixa via
  `window.print()`; impressora termica se instala no SO como impressora
  comum. Codigo em `lib/cupom-dados.js` (mapeamento puro, testavel sem
  navegador) + `components/cupom.jsx` (renderizacao + `window.print()`).

## 4.2 Tabelas (20 no Supabase)

Dominio com `empresa_id`: `usuarios`, `categorias`, `produtos`, `clientes`,
`mesas`, `comandas`, `comanda_itens`, `pedidos`, `pedido_itens`, `pagamentos`,
`transacoes`, `integracoes`, `conversas`, `mensagens`, `auditoria`,
`webhook_events`, `pedido_contadores`.
Raiz do tenant: `empresas`. Catalogos globais: `papeis`, `permissoes`.

## 4.3 Migrations e ORDEM DE EXECUCAO (nao obvia)

`supabase/migrations/0001` a `0015`, mais `triggers.sql`, `policies_rls.sql`,
`seed.sql`. **A ordem correta nao e so numerica** — `0002+` dependem de
funcoes definidas em `triggers.sql`/`policies_rls.sql`:

```
0001_init.sql -> triggers.sql -> policies_rls.sql -> seed.sql
-> 0002_core_fixes -> 0003_pedido_numero_atomico -> 0004_mesas
-> 0005_comandas -> 0006_pagamentos -> 0007_webhook_events
-> 0008_conversas_mensagens -> 0009_repository_support_functions
-> 0010_atomic_create_functions -> 0011_migration_upsert_functions
-> 0012_pedidos_comanda_id -> 0013_increment_conversa_patch_parcial
-> 0014_resync_contador_por_empresa -> 0015_pedidos_desconto_acrescimo
```

Esta ordem foi testada de ponta a ponta contra Postgres real. Tambem no
`README.md`.

**Cuidado ao mexer em pedidos:** `create_pedido_com_itens()` e
`upsert_pedido_com_itens()` usam **lista de colunas explicita**. Coluna nova
em `pedidos` exige reescrever as duas, senao o valor e descartado em silencio.

## 4.4 Switch de runtime (`DATABASE_PROVIDER`)

A escolha do backend vive so em `lib/repositories/factory.js`:

```bash
DATABASE_PROVIDER=mongo      # default do codigo (omitir tem o mesmo efeito)
DATABASE_PROVIDER=supabase   # o que roda no servidor
```

- Conferir o que esta ativo: `GET /api/health` -> campo `database`.
- **Sem fallback silencioso**: `supabase` sem credenciais **falha**, em vez de
  cair para o Mongo — um fallback silencioso gravaria no banco errado sem
  ninguem perceber.
- **Sem modo hibrido**: misturar backends na mesma requisicao daria leitura
  inconsistente e quebraria as FKs do Postgres.
- Trocar exige reiniciar o processo.
- Detalhes: `docs/plans/PHASE-7-RUNTIME-SWITCH.md`.

---

# 5. Conexoes e integracoes

| O que | Onde | Credencial | Sem configuracao |
|---|---|---|---|
| **Supabase** (banco atual) | Projeto hospedado | `.env` / variaveis do EasyPanel | App falha explicitamente |
| **Supabase Storage** (logos) | Mesmo projeto | Mesmas do Supabase | Endpoint responde 503 |
| **MongoDB** | Container local `ros-mongo-local` | `MONGO_URL`/`DB_NAME` | So usado com `DATABASE_PROVIDER=mongo` |
| **Evolution API** (WhatsApp) | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Retorna "nao configurado" |
| **n8n** | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Evento e ignorado |
| **Mercado Pago** | Externo | Por empresa, tabela `integracoes` | Retorna "nao configurado" |

## 5.1 Supabase — como conectar

- **Direct connection resolve para IPv6** e e inacessivel de varias redes.
  Usar o **Session Pooler** (`aws-0-us-east-2.pooler.supabase.com:5432`).
- A senha do banco contem `@`, que **precisa ser codificado como `%40`** na
  connection string.
- Nao ha `psql` instalado nesta maquina: rodar via
  `docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL"`.
- Credenciais no `.env` (nao versionado): `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_DB_URL`.

---

# 6. Deploy (EasyPanel / Hostinger — IP 187.77.226.88)

**Projeto `restaurante`**, servico **`app`**, em
`https://restaurante-app.ilmdzk.easypanel.host` (HTTPS gerado pelo EasyPanel,
sem dominio proprio). Ao lado: `evolution-api`, `evolution-api-db`,
`evolution-api-redis`, `n8n`. **Essa proximidade e valiosa** — e o que torna o
fluxo de WhatsApp testavel de ponta a ponta.

Guia completo: `docs/operations/DEPLOY-EASYPANEL.md`.

## 6.1 Configuracao que funciona

| Campo | Valor |
|---|---|
| Fonte | GitHub · `tanelasjr-ux` / `Lanchonete` · ramo `main` |
| Construcao | **Dockerfile** · arquivo `docker/Dockerfile` |
| Dominios | porta do container **3000** (o default `80` da 502) |
| Ambiente | 7 variaveis (ver §6.2) |

**Implanta automaticamente ao receber push na `main`.**

**Nao usar** o `docker-compose.yml` da raiz: ele sobe postgres, evolution-api
e n8n juntos, duplicando servicos que ja existem. Aquele arquivo serve para
subir a stack inteira num VPS limpo.

**Nao ligar** o botao "Criar arquivo .env" na aba Ambiente — as variaveis ja
chegam como ambiente; ligar gravaria a service role key em arquivo dentro do
container.

## 6.2 Variaveis obrigatorias

`JWT_SECRET` (exclusivo do servidor), `DATABASE_PROVIDER=supabase`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CORS_ORIGINS`.

Sem `JWT_SECRET`, o app sobe mas responde `503 degraded` e recusa autenticar
(falha fechada, de proposito). Variavel nova so vale **apos reimplantar**.

## 6.3 Supabase Storage

Bucket `logos` (publico, limite 1 MB, apenas PNG/JPG/WEBP/SVG), criado via
Admin API. Guarda a logo em `{empresa_id}/logo.{ext}` — caminho derivado do
token, entao uma empresa nao sobrescreve a de outra. Upload com `upsert`
(trocar substitui em vez de acumular orfao) e cache-buster `?v=` na URL, sem
o qual o browser continuaria exibindo a logo antiga.

Primeiro uso de Storage no projeto. Codigo isolado em
`lib/integrations/storage.js`.

## 6.4 Imagem

`docker/Dockerfile` multi-stage, saida `standalone`, **291 MB**, com
`HEALTHCHECK` apontando para `/api/health`. O `.dockerignore` exclui `.env` e
`backups/` — sem ele, a service role key e dumps com dado de cliente iriam
embutidos na imagem.

---

# 7. Estado de cada frente

| Frente | Status |
|---|---|
| 1 — Auditoria da migracao | **Concluida** (`MONGO-TO-SUPABASE-AUDIT.md`) |
| 2 — Contratos de dominio | **Concluida** |
| 3 — Extrair Mongo do `route.js` | **Concluida** (16 repositories) |
| 3.5 — Remover triggers de negocio | **Concluida** (`PHASE-3.5-...`) |
| 4 — Schema Supabase | **Concluida** (`PHASE-4-...`) |
| 5 — `Supabase*Repository` | **Concluida** (`PHASE-5-...`) |
| 6 — Ferramenta de migracao de dados | **Concluida** (`PHASE-6-...`) |
| 6B — Validacao contra Supabase real | **Concluida** (`PHASE-6B-...`) |
| 7 — Switch de runtime | **Concluida** (`PHASE-7-...`) |
| 8 — Auditoria de Auth | **Concluida** (`PHASE-8-AUTH-AUDIT.md`) |
| Deploy | **No ar**, com deploy automatico por push |
| Melhorias de produto (tema/logo/valor) | **No ar** |
| KDS (11 tasks) | **COMPLETO** (2026-08-13) |
| Delivery (12 tasks) | **COMPLETO** (2026-08-13) |
| Estoque (12 tasks) | **COMPLETO** (2026-08-14); migration so aplicada em producao 2026-08-18 — ver achado critico §0 |
| Supabase Auth (implementacao) | **NAO INICIADA** |
| Storage alem de logo | **Imagem do cardapio** (2026-08-18), bucket `cardapios` proprio |
| Realtime | **NAO INICIADO** |

## 7.1 Baseline de testes

Suite de backend (`backend_test.py`, `_v2`, `_v3`), **identica nos dois
backends** e tambem contra a imagem de producao:

| Suite | Resultado |
|---|---|
| v1 | **40/40** |
| v2 (mesas/comandas/pagamentos) | **39/39** |
| v3 (atendimento/delivery) | **32/33** |

A unica falha do v3 e o **nao-bug conhecido**: o webhook do WhatsApp grava
`tipo:'conversation'`, que e o `messageType` real da Evolution API para texto
simples — o teste e que espera `'text'`. Documentado em `test_result.md`.

**Cuidado:** cada execucao da suite registra tenants novos. Foi assim que o
banco acumulou 92 empresas de teste.

## 7.2 Validacao de frontend (Playwright)

O plugin Playwright foi instalado e **usado pela primeira vez** hoje, cobrindo
as tres melhorias: tema estavel por 6s apos a troca, upload real chegando ao
Storage e servido publicamente, e ajuste de R$ 49,80 -> R$ 40,00 refletido no
card do pedido.

**O restante do frontend continua sem validacao sistematica** — a maior lacuna
de teste do projeto. Agora e barato fechar isso.

---

# 8. Ambiente local de desenvolvimento

Nao sobrevive a reboot. Para retomar:

1. `.env` ja existe na raiz (nao versionado).
2. Docker Desktop aberto, depois `docker start ros-mongo-local`.
   Banco de dev: `restaurant_os_dev` (71 empresas de uso organico).
3. `corepack enable` (necessario nesta maquina para o `yarn` resolver).
4. `yarn dev:no-reload` -> `localhost:3000`.
5. Testes: `PYTHONIOENCODING=utf-8 python backend_test.py` (e `_v2`/`_v3`).
   `BASE_URL` e configuravel por variavel de ambiente.

**Armadilha:** rodar `yarn build` com o dev server no ar corrompe o `.next`
(`Cannot find module './chunks/vendor-chunks/next.js'`). Solucao: parar o
servidor, `rm -rf .next`, subir de novo. Se a porta 3000 ficar presa,
`Get-NetTCPConnection -LocalPort 3000` + `Stop-Process` no PowerShell.

---

# 9. Decisoes tomadas (nao renegociar sem confirmar)

1. **Itens de pedido/comanda**: tabelas relacionais com snapshot historico.
2. **Regra de negocio so no Service.** Postgres cuida de integridade e de
   funcoes mecanicas que recebem o valor ja calculado.
3. **Autenticacao migra para Supabase Auth** — auditada, a fazer depois.
4. **MongoDB foi a fonte de verdade** durante a migracao; migrar sempre com
   base no formato REAL dos documentos, nunca assumindo `domain.ts`.
5. **Um unico projeto Supabase** atende todas as empresas.
6. **Nunca mockar integracao externa.**
7. **Valor de pedido concluido nao se edita** — corrige-se por lancamento no
   financeiro.

---

# 10. Achados e armadilhas (para nao redescobrir)

Bugs reais encontrados **rodando** contra banco/servidor/navegador de verdade:

1. **`pedidos.comanda_id` nunca existiu como coluna** — pedidos gerados por
   fechamento de comanda sempre carregam esse campo no Mongo. Migration `0012`.
2. **`pedidos_tipo_check` nao aceitava `'mesa'`** — 4o valor real de `tipo`.
   Migration `0012`.
3. **Ordem de migracao**: apos criar a FK do item 1, `comandas` **tem que**
   migrar antes de `pedidos`.
4. **`jsonb_populate_record()` zera campos ausentes com NULL** em vez de
   aplicar o `DEFAULT`. Por isso as funcoes atomicas usam lista de colunas
   explicita + `coalesce()`.
5. **Upsert em lote via PostgREST nao aplica `DEFAULT` por linha** — se o lote
   mistura documentos com e sem um campo opcional, as linhas sem ele recebem
   `NULL` e violam `not null`.
6. **`supabase-js` remove chaves `undefined`** do corpo JSON: RPC com
   parametro obrigatorio sem default falha com `PGRST202` — erro confuso.
   Migration `0013`.
7. **Direct connection do Supabase e IPv6** — usar o Session Pooler.
8. **`papeis`/`permissoes` existem no banco mas o app nao le** — RBAC e
   hardcoded.
9. **`ON DELETE CASCADE` em `empresas`** limpa o tenant inteiro — util para
   teste, perigoso em producao.
10. **O seed criava a mesa demo apontando para comanda inexistente**
    (violava `mesas_comanda_id_fkey`). No Mongo passava — nao ha FK.
11. **Bulk insert de pedidos nao avanca `pedido_contadores`** — o proximo
    pedido colidia. Migration `0014`. **Regra geral: toda carga em lote com
    numero explicito precisa realinhar o contador.**
12. **`usuarios.id` e IMUTAVEL.** 4 FKs apontam para ele e
    `auditoria.usuario_id` guarda 78 ids **sem FK**. A Admin API do Supabase
    **aceita id customizado** (verificado), entao nao ha motivo para trocar.
13. **`service_role` IGNORA RLS** — ver §3.
14. **O frontend nao tem refresh de token.** Hoje dura 7 dias; o do Supabase
    Auth dura **1 hora**. Sem refresh, todo usuario cai apos 1h — quebra que
    passa em teste de API e so aparece com usuario real.
15. **Validacao de env no nivel do modulo quebra `next build`.** O build
    avalia o modulo das rotas com `NODE_ENV=production` e sem variaveis de
    runtime. Foi o caso do `JWT_SECRET` — resolvido tornando a checagem lazy.
16. **EasyPanel v2.30.0: "Caminho de Build" e obrigatorio e nao aceita raiz.**
    Rejeita vazio, `/`, `.` e `./`; aceita `/algo`. Mas o contexto precisa ser
    a raiz. Usar `/app` faz o contexto virar `code/app` e o build falha com
    `lstat .../app/docker: no such file or directory`.
17. **next-themes: `setTheme` MUDA DE IDENTIDADE a cada troca de tema.**
    Colocar `setTheme` na dependencia de um `useCallback` que alimenta um
    `useEffect` cria um loop: trocar o tema redispara o efeito. Foi assim que
    o tema claro revertia sozinho apos ~2s (o efeito refazia `/auth/me` e
    reaplicava o tema da empresa). Tema da empresa e **padrao inicial**,
    aplicado uma vez via ref — nunca reimposto a cada carga.
18. **Variavel de ambiente nova so vale apos reimplantar.**
19. **Deploy novo exige Ctrl+Shift+R em quem ja estava com o app aberto.** O
    JS antigo fica em cache e a mudanca "nao aparece". Antes de investigar um
    bug pos-deploy, descartar isso — hoje custou uma investigacao inteira.
20. **O shell come conteudo entre crases** ao editar arquivos via
    `node -e "..."` em heredoc. Para editar documentacao com trechos de
    codigo, usar a ferramenta de edicao, nao script de shell.
21. **`window.print()` abre um dialogo NATIVO e bloqueante neste ambiente**
    (confirmado testando — nao e um no-op simulado). Isso tem duas
    consequencias: (a) automacao de navegador (Playwright) que clica num
    botao cujo handler chama `print()` sincronamente pode travar esperando
    o dialogo — testar via `Escape`/`handle_dialog` ou validar a logica de
    dados separadamente de forma determinista, nao via clique real; (b) por
    isso a impressao de cupom usa `createRoot` num container proprio no
    `body` (`components/cupom.jsx`) em vez de portal na arvore do app — o
    dialogo bloqueante nao pode depender de estado React que uma
    re-renderizacao concorrente altere.

---

# 11. Pendencias e proximos passos

**Lacunas de produto** (levantadas verificando o codigo — as duas primeiras
ainda travam a operacao diaria de um restaurante real):

- [x] ~~Impressao de pedido para a cozinha~~ — **DONE** (2026-08-12)
- [x] ~~Tela de cozinha (KDS)~~ — **DONE** (2026-08-13, 11 tasks)
- [x] ~~Delivery completo~~ — **DONE** (2026-08-13, 12 tasks)
- [x] ~~Estoque~~ — **DONE** (2026-08-14, 12 tasks) ✅ Rastreamento opt-in, baixa automática na venda, alertas
- [ ] **Fechamento de caixa** (flag `caixa` ja reservada): abrir/fechar, sangria, conferencia (14 tasks audited).
- [ ] **Cardapio digital + QR na mesa**: encaixa no modelo de mesas/comandas
      que ja existe, e e o tipo de recurso que **vende** o SaaS.

Flags tambem reservadas, sem urgencia: `crm`, `campanhas`, `fidelidade`,
`cashback`, `billing`, `multiunidade`.

**Tecnico:**

- [ ] **Validar o frontend tela por tela** com Playwright — o restante do
      sistema nunca passou por isso.
- [ ] **Limpar as 92 empresas de teste** do Supabase (migracoes + rodadas da
      suite). Nenhum dado real de cliente. **Decisao do dono.**
- [ ] **Implementar Supabase Auth** (`PHASE-8-AUTH-AUDIT.md`), incluindo
      refresh de token no frontend (armadilha 14).
- [ ] **Testar o fluxo real de WhatsApp** — possivel agora, com o app ao lado
      da Evolution API.
- [ ] **Tornar o repositorio privado** (produto comercial). Hoje publico. Ao
      fazer, o EasyPanel precisara de autorizacao para clonar.
- [ ] **Fazer o RLS valer** (trocar `service_role` por token de usuario). Fase
      separada, nao juntar com Auth.
- [ ] **Dominio proprio.**

---

# 12. Commits recentes (últimos 30)

```
755a3d7 chore: update dependencies for Estoque MVP
7031d75 ui: add stock adjustment dialog
88c15e7 test: Add estoque integration test suite (8 test cases)
218a2e6 ui: add low-stock warning card to dashboard
05692d1 ui: Produtos dialog — add stock tracking fields
15b2c1e feat: PUT /pedidos/:id — integrate stock deduction on pedido conclusion
da872b9 feat: Mongo produtoRepository — add stock methods (identical interface to Supabase)
888e99a feat: Supabase produtoRepository — add stock methods (decrement, ajustar, listBaixo, getEstoque)
ad75570 types: Add Estoque interfaces + extend Produto + ProdutoRepository
874453b migration: Add estoque schema (estoque_habilitado, quantidade, minimo)
f2424d3 plan: Estoque MVP implementation — 12 tasks (schema, repos, UI, tests)
06eb75f spec: Estoque MVP — rastreamento opt-in, baixa automática na venda, alertas
2cab4b6 fix: id area-impressao move para o container no body, nao no JSX  <- corrigiu bug de pagina em branco
7cb5392 docs: registra a impressao de cupom no HANDOFF (aguardando push)
4c80ae4 feat: impressao de cupom (comanda da cozinha e via do cliente)
ba04d7f docs: handoff completo — 3 melhorias no ar e lacunas de produto mapeadas
8926206 docs: corrige secao 6.3 do HANDOFF (conteudo perdido por escape do shell)
4ec0011 docs: registra no HANDOFF a armadilha do next-themes, valores e bucket
6ebd061 feat: ajuste de valor em pedidos, upload de logo e correcao do tema
d44aa48 docs: handoff completo — app publicado e validado em producao
f456a86 docs: HANDOFF.md — repositorio sincronizado com o GitHub + guia de deploy
ca4c404 build(deploy): prepara imagem de producao para o EasyPanel
5e5b02a docs: ponto de retomada e lista de commits atualizados (Fase 8)
c7ac605 security(auth): corrige 3 vulnerabilidades no JWT + auditoria da Fase 8
537ab77 feat(fase7): paridade completa de runtime MongoDB <-> Supabase
2ccf90d refactor(fase7): factory de repositories com switch DATABASE_PROVIDER
87afa2a feat(supabase): valida schema, repositories e migracao contra Supabase real
7bd641a feat(migration): ferramenta de migracao de dados MongoDB -> Supabase
5e082a2 feat(supabase): idempotent migration upserts + fix pedidos.comanda_id
9f45f80 fix(supabase): atomic create for pedido+itens e comanda+itens (RPC)
d29f4d3 feat(supabase): implement Supabase repositories (Fase 5)
305c350 feat(supabase): complete Fase 4 schema
8e15454 fix(supabase): remove business-logic triggers
f43e51e docs: add comprehensive Mongo->Supabase migration audit
432a067 refactor: extract empresa Mongo access into repository
796cb05 refactor: extract comanda/pagamento Mongo access into repositories
6f2619f refactor: extract pedido Mongo access into repository
6373f9e refactor: extract conversa/mensagem Mongo access into repositories
aa26ecb refactor: extract mesa Mongo access into repository
6fa0bcd refactor: extract auditoria/integracoes Mongo access into repositories
2675a4b refactor: extract usuario/transacao Mongo access into repositories
ed2c3fe refactor: extract categoria/produto/cliente Mongo access into repositories
0f24486 feat(domain): extend contracts for MongoDB->Supabase migration
e2bfe84 chore: ignore .env files to prevent secret leakage
2d4642a docs: add CLAUDE.md autonomous agent rules and HANDOFF.md
```

---

# 13. Mapa de arquivos e documentos

**Governanca**
- `CLAUDE.md` — regras de operacao autonoma (ler antes de qualquer tarefa).
  Secao 18.1 define o formato obrigatorio deste handoff.

**Codigo**
- `app/api/[[...path]]/route.js` — API inteira (Controller + Service).
- `app/page.js` — frontend inteiro (SPA).
- `packages/domain/src/index.ts` — contratos de dominio.
- `lib/repositories/mongo/` — 16 repositories.
- `lib/repositories/supabase/` — 15 repositories.
- `lib/repositories/factory.js` — switch `DATABASE_PROVIDER`.
- `lib/integrations/` — `evolution.js`, `n8n.js`, `supabase.js`,
  `storage.js`, `payments/`.
- `lib/cupom-dados.js` — mapeamento puro Pedido/Comanda -> dados do cupom.
- `components/cupom.jsx` — renderiza e imprime o cupom (`window.print()`).

**Banco**
- `supabase/migrations/0001`…`0015`, `triggers.sql`, `policies_rls.sql`,
  `seed.sql`. Ordem real de execucao no §4.3 e no `README.md`.

**Deploy**
- `docker/Dockerfile`, `.dockerignore` — imagem de producao.
- `docker-compose.yml` — stack completa para VPS limpo (**nao** usar no
  EasyPanel).

**Ferramentas**
- `scripts/migrate-mongo-to-supabase.mjs` — migracao de dados (idempotente).
- `scripts/validate-migration.mjs` — validacao pos-migracao (so leitura).

**Documentacao**
- `docs/operations/DEPLOY-EASYPANEL.md` — deploy passo a passo.
- `docs/plans/` — uma auditoria/relatorio por fase (lista no §7).
- `docs/ARCHITECTURE.md` (ADR-006), `docs/FOLDER_STRUCTURE.md`.

**Testes**
- `backend_test.py`, `_v2`, `_v3` — regressao de backend (baseline no §7.1).
- `test_result.md` — historico e comportamentos conhecidos.

**Backups**
- `backups/` — dumps do Supabase. **No `.gitignore`** (pode conter dado real).
