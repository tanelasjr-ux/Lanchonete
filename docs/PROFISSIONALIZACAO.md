# Programa de Profissionalizacao — Restaurant OS

**Criado:** 2026-08-14
**Natureza:** documento vivo, executado ao longo de varias sessoes

---

## Como usar este documento

Este e o backlog de **saude tecnica e prontidao comercial** do produto — separado
do roadmap de features, que vive no `HANDOFF.md`.

**Ao retomar em qualquer sessao:**

1. Leia a tabela de status abaixo e escolha o primeiro item `⚪ pendente` da
   trilha de maior prioridade
2. Cada item tem **Evidencia** (onde ver o problema no codigo), **Por que
   importa**, **O que fazer** e **Pronto quando** — nao precisa reconstruir o
   raciocinio
3. Ao concluir, marque `✅` na tabela, anote o commit, e **commite este arquivo**

**Regra:** um item por vez, commitado antes do proximo. Itens `P` (pequeno)
podem ser agrupados numa sessao; itens `G` merecem spec e plano proprios via
`superpowers:brainstorming`.

**Tamanhos:** `P` = uma sessao curta · `M` = uma sessao inteira · `G` = precisa
de spec + plano proprios.

---

## Status

`✅` concluido · `🟡` parcialmente concluido (ver detalhe no item) · `⚪` pendente

| # | Item | Trilha | Tam | Status | Commit |
|---|------|--------|-----|--------|--------|
| A1 | Consolidar e executar as suites de teste | Confianca | P | ✅ | `b46d88e`,`be8f167`,`f79a46b` |
| A2 | Eliminar falhas silenciosas na UI | Confianca | P | ✅ | `e12abe8` |
| A3 | Monitoramento de erro em producao | Confianca | M | ⚪ | |
| A4 | Testes E2E dos fluxos criticos | Confianca | G | ⚪ | |
| B1 | Feature flags que realmente controlam acesso | Comercial | M | ⚪ | |
| B2 | Onboarding de novo restaurante | Comercial | M | ⚪ | |
| B3 | Billing e assinatura | Comercial | G | ⚪ | |
| B4 | Emissao fiscal (NFC-e) | Comercial | G | ⚪ | |
| C1 | Limpar empresas de teste da producao | Operacao | P | 🟡 | (sem commit — dado, nao codigo) |
| C2 | Multiplos caixas por empresa | Operacao | M | ⚪ | |
| C3 | Supabase Auth + refresh de token | Operacao | G | ⚪ | |
| C4 | RLS realmente ativa | Operacao | G | ⚪ | |
| C5 | Integracao iFood / Rappi | Operacao | G | ⚪ | |
| C6 | Migrations de schema nao fazem parte do deploy | Operacao | M | ✅ | `scripts/migrate.mjs` + `docker/entrypoint.sh` |
| D1 | Extrair regra de negocio do route.js | Sustentacao | M | ⚪ | |
| D2 | Quebrar o page.js em telas | Sustentacao | G | ⚪ | |

**Ordem recomendada:** `A1 → A2 → C1 → B1 → A3 → D1 → B2 → ...`
Comeca pelos pequenos que reduzem risco imediato, antes dos grandes.

---

# Trilha A — Confianca

> Impedem que mudancas quebrem o que ja funciona. Sao os itens de maior retorno
> por esforco, porque todo o resto do programa depende de conseguir mudar o
> sistema sem medo.

## A1 — Consolidar e executar as suites de teste `P`

**Evidencia:** os arquivos de teste estao em dois lugares e ninguem roda os dois
conjuntos.

```
raiz/    backend_test.py  backend_test_v2.py  backend_test_v3.py
         backend_test_caixa.py  backend_test_kds.py
tests/   backend_test_cardapio.py  backend_test_estoque.py
```

`backend_test_caixa.py` e `backend_test_kds.py` **nunca foram executados**. Os
dois blockers do Caixa (2026-08-14) seriam pegos por qualquer teste que abrisse e
fechasse um caixa com uma venda dentro.

**Por que importa:** seis suites que ninguem roda valem zero. Pior que zero:
criam a sensacao de estarem cobertos.

**O que fazer:**
1. Mover todas as suites para `tests/`
2. Criar `tests/run_all.py` que descobre e roda todos os `backend_test_*.py`,
   imprimindo um resumo consolidado
3. Adicionar `"test": "python3 tests/run_all.py"` aos scripts do `package.json`
4. **Rodar** e registrar o resultado real — inclusive as falhas
5. Documentar no `HANDOFF.md` o comando unico

**Pronto quando:** `npm test` roda todas as suites e imprime
`N/M testes passaram`; qualquer falha existente esta documentada como bug
conhecido ou corrigida.

---

**✅ CONCLUIDO em 2026-08-16.** `npm test` roda `tests/run_all.py`, que descobre
as 7 suites, executa cada uma como subprocesso e da o resumo consolidado.
Resultado real, contra ambiente local (Docker + Mongo, producao intocada):
**7/7 suites, 0 falhas, ~9 minutos.**

O trabalho nao foi so mover arquivo. A primeira execucao de verdade (a suite
inteira nunca tinha rodado) encontrou seis problemas reais, cada um corrigido:

**No runner (`b46d88e`):**
- 4 das 7 suites imprimiam falha e saiam com codigo 0 — nenhum runner que
  confiasse no exit code jamais teria pego uma quebra nelas
- O runner aborta com codigo 2 se a API nao responder, para nunca reportar
  "0 passaram" como se fosse resultado

**No backend (`be8f167`)** — achado direto por `backend_test_estoque.py`
rodando pela primeira vez, nao suspeita previa:
- `POST /produtos` e `PUT /produtos/:id` gravam a partir de **lista explicita
  de campos**. Os tres campos de estoque nunca estiveram nela — o toggle
  "Rastrear Estoque" do dialog era um no-op silencioso desde que a Estoque MVP
  foi entregue como "12/12 completo". Corrigido nos dois handlers.
- `GET /produtos/:id` nao existia — so list-all e PUT/DELETE por id.

**Nos testes (`f79a46b`):**
- `backend_test_cardapio.py` chamava `/signup` (nunca existiu) com um formato
  de resposta que tambem nunca existiu. Reescrito para `/auth/register`, e
  junto, corrigido pra ser robusto ao seed de demonstracao que toda empresa
  nova ja ganha (o teste assumia cardapio vazio, premissa que caiu quando o
  seed nasceu). Reforcado alem do original: agora prova ausencia cross-tenant
  e ausencia de produto indisponivel, que a versao anterior nunca verificava.
- `backend_test_v3.py` tinha 1 falha: o nao-bug ja documentado do webhook da
  Evolution API (`tipo:'conversation'` vs `'text'`). Assercao ajustada pra
  aceitar o valor real, aceito desde a migracao Mongo→Supabase.
- O detector de falso-positivo do proprio runner tinha um falso-positivo: batia
  em `❌ FAILED: 0` so por comecar com o emoji, sem checar o numero.

**Consequencia para o CMV:** o plano de implementacao ja escrito
(`docs/superpowers/plans/2026-08-14-custo-margem-implementation.md`) tinha a
mesma lacuna — a Task 5 so tocava o frontend. Corrigido no proprio plano
(commit seguinte) antes de qualquer task ser executada.

---

## A2 — Eliminar falhas silenciosas na UI `P`

**Evidencia:** o alerta de estoque baixo foi entregue como "12/12 ✅ COMPLETO" e
**nunca funcionou**. O endpoint `/produtos/estoque-baixo` nao existia; o
componente chamava a rota a cada 30 segundos, recebia 404, e engolia:

```javascript
} catch (e) {
  console.warn('Erro ao carregar estoque baixo:', e.message)
  setProdutos([])          // erro vira "nao ha nada"
}
```

Corrigido em `31c1bf0`, mas **o padrao continua no resto do arquivo**.

**Por que importa:** um `catch` que transforma erro em estado vazio nao esconde
uma falha da UI — esconde da equipe. Este ficou invisivel por semanas.

**O que fazer:**
1. Varrer `app/page.js` por `catch` que descarta erro (`console.warn`,
   `console.error`, ou vazio) e substitui por estado vazio
2. Para cada um, escolher: mostrar erro ao usuario, ou deixar o componente
   sumir **com** um `console.error` que diga qual chamada falhou
3. Nunca: transformar erro em "lista vazia" indistinguivel do caso legitimo
4. Priorizar os que fazem polling — sao os que geram ruido continuo

**Pronto quando:** nenhum `catch` em `page.js` converte falha de rede em estado
vazio silencioso; os que degradam de proposito tem comentario explicando por que.

---

**✅ CONCLUIDO em 2026-08-18** (`e12abe8`). Varredura completa: 83 ocorrencias
de `catch` em `page.js`, 25 sem `toast.error` no mesmo bloco. Classificacao:

- **12 legitimos** (falso-positivo do grep de linha unica — `toast.error` na
  linha seguinte do mesmo bloco — ou padrao ja correto: erro mostrado via
  estado local renderizado, ou fallback de parse de JSON seguido de
  `if (!res.ok) throw`)
- **8 violacoes reais** (zero sinal, nem `console.error`) — corrigidas com
  `console.error` identificando a chamada, ou `toast.error` onde o impacto
  justifica interromper o usuario. A mais significativa: as 4 chamadas que
  populam `PedidoDialog` (produtos/clientes/empresa/mesas) — se qualquer uma
  falhasse, o operador via um dialog de novo pedido vazio sem saber se era bug
  ou ausencia real de produto
- **4 parciais** (ja tinham `console.warn`/comentario, mas nao explicavam
  o *porque* do degrade silencioso) — ganharam comentario. Todos em polling
  de 30s (estoque baixo) ou 5s (lista de conversas em Atendimento), onde
  toast a cada falha seria ruido continuo — nao e falha escondida, e
  decisao de UX documentada
- **1 caso deliberadamente nao alterado**: `loadMe()` (App raiz) trata
  qualquer erro — 401 de token invalido OU 500/rede transitoria — como
  "sessao invalida" e desloga. Nao e falha silenciosa (efeito visivel: kick
  pro login), mas a causa raiz exige que `api()` carregue o status HTTP no
  erro pra distinguir os dois casos. Pertence a trilha **C3** (Supabase Auth
  + refresh de token), nao a este item — documentado inline no codigo.

**Consequencia para C3:** quando C3 for atacado, ja ha um ponto de entrada
mapeado (`loadMe()`) e a mudanca estrutural necessaria (status HTTP no erro
de `api()`) identificada.

---

## A3 — Monitoramento de erro em producao `M`

**Evidencia:** nao ha Sentry, Datadog, Bugsnag ou equivalente no
`package.json`. O unico sinal de saude e `GET /api/health`, que so reporta
configuracao faltando — nao reporta erro em execucao.

**Por que importa:** hoje um erro em producao so aparece se o dono reclamar. Para
um produto vendido a terceiros, isso nao se sustenta: o cliente descobre antes de
voce, e a confianca se perde na primeira vez.

**O que fazer:**
1. Escolher a ferramenta (Sentry tem plano gratuito adequado a este porte)
2. Instrumentar o `route.js` no ponto unico onde a excecao vira resposta 500
3. Instrumentar o frontend no wrapper `api()`, por onde toda chamada ja passa
4. **Enviar `empresa_id`, nunca dado do cliente final** — nome, telefone e
   endereco de consumidor nao vao para servico externo
5. Configurar alerta para taxa de erro acima do normal

**Pronto quando:** um erro forcado em producao aparece no painel em menos de um
minuto, com `empresa_id` e rota, e sem nenhum dado pessoal.

---

## A4 — Testes E2E dos fluxos criticos `G`

**Evidencia:** cinco modulos complexos, zero teste de interface. O Playwright ja
foi usado pontualmente neste projeto (tema, logo, impressao), mas nao ha suite.

**Por que importa:** as suites Python cobrem a API. Toda a camada onde o operador
realmente trabalha — 2.920 linhas de `page.js` — nao tem rede de protecao.

**O que fazer:** spec propria. Cobrir no minimo: login, criar e concluir pedido,
abrir/fechar comanda com dois metodos de pagamento, abrir/fechar caixa com
conferencia, marcar item pronto no KDS.

**Pronto quando:** a suite roda em CI e falha quando um desses fluxos quebra.

---

# Trilha B — Comercial

> Impedem vender o produto como SaaS de verdade.

## B1 — Feature flags que realmente controlam acesso `M`

**Evidencia — este e o achado mais importante do programa.** As flags existem:

```javascript
// route.js:530 — criadas no signup
feature_flags: { mesas: true, comandas: true, estoque: false, crm: false,
                 campanhas: false, fidelidade: false, cashback: false,
                 billing: false, caixa: false, multiunidade: false }
```

Podem ser editadas (`route.js:778`) e tem uma aba "Modulos" na tela de
configuracoes (`page.js:1991`). Mas **nenhum dos 81 endpoints consulta uma
flag**. A autorizacao usa `can(ctx.papel, 'modulo')` — papel, nunca plano.

Consequencias reais hoje:
- Desligar "Estoque" na tela **nao desliga** o Estoque
- Estoque e Caixa nascem com a flag `false` no signup e funcionam mesmo assim
- E a mesma armadilha das tabelas `papeis`/`permissoes`, que existem com seed e
  nunca sao lidas (HANDOFF §2.4)

**Por que importa:** **sem isso nao existe plano Basico e plano Pro.** Nao ha como
cobrar mais por um modulo se o modulo nao pode ser desligado. Este item e
pre-requisito de B3 (billing) — nao adianta cobrar por algo que nao se controla.

**O que fazer:**
1. Criar um helper unico, ao lado do `can()`, no formato
   `temModulo(empresa, 'estoque')`
2. Aplicar nos endpoints de cada modulo opcional — comecar por `caixa` e
   `estoque`, que ja existem e ja estao com a flag errada
3. **Corrigir o signup:** as flags precisam refletir o plano contratado, e o
   default precisa bater com o que o produto entrega hoje
4. Na UI, esconder a navegacao do modulo desligado — mas **sem confiar so nisso**;
   o portao real e no servidor
5. Escrever teste de isolamento: empresa sem a flag recebe 403 no endpoint

**Pronto quando:** desligar "Estoque" na tela de configuracoes faz o endpoint de
estoque responder 403 e o item sumir da navegacao.

**Cuidado:** o default precisa ser retrocompativel. As 71+ empresas ja
cadastradas nao podem perder acesso a um modulo que usam hoje.

---

## B2 — Onboarding de novo restaurante `M`

**Evidencia:** o `signup` cria empresa e usuario e entrega o app vazio. Nao ha
passo guiado.

**Por que importa:** o momento entre "assinei" e "estou usando" e onde se perde
cliente em SaaS. Um restaurante que abre a tela e ve tudo em branco nao sabe por
onde comecar — e o suporte vira o onboarding, o que nao escala.

**O que fazer:**
1. Checklist de primeiros passos na tela inicial: cadastrar categoria, cadastrar
   primeiro produto **com custo**, configurar formas de pagamento, criar mesas
2. Cada item marca sozinho quando cumprido — nunca manualmente
3. O checklist some quando completo
4. Reaproveitar o seed de demonstracao ja existente como opcao "quero ver com
   dados de exemplo"

**Pronto quando:** um restaurante novo consegue registrar a primeira venda sem
ninguem explicar nada.

---

## B3 — Billing e assinatura `G`

**Evidencia:** flag `billing: false` reservada, nenhuma implementacao. Nao ha
tabela de plano, assinatura, ciclo ou inadimplencia.

**Por que importa:** e literalmente como o produto ganha dinheiro.

**Depende de:** **B1**. Cobrar por plano exige que o plano controle algo.

**O que fazer:** spec propria. Decidir no minimo: quais planos e o que cada um
inclui; ciclo de cobranca; o que acontece na inadimplencia (bloqueia? degrada
para leitura?); periodo de teste; e qual gateway — o Mercado Pago ja esta
integrado para Pix de cliente final, mas assinatura recorrente e outro produto.

**Pronto quando:** um restaurante assina, e cobrado, e perde acesso aos modulos
do plano superior ao cair para o plano inferior.

---

## B4 — Emissao fiscal (NFC-e) `G`

**Evidencia:** documentado como fora de escopo desde a impressao de cupom. O que
existe hoje e comprovante de producao e atendimento — **nao e documento fiscal**.

**Por que importa:** e bloqueio comercial real no Brasil. Restaurante que vende
precisa emitir. Muitos clientes nao conseguem contratar sem isso.

**O que fazer:** spec propria. **Nao integrar direto com a SEFAZ** — exige
certificado digital, contingencia, e regras que mudam por estado. O caminho e
intermediario fiscal: Focus NFe, NFe.io ou Tecnospeed.

**Pronto quando:** uma venda gera NFC-e autorizada, com o DANFE impresso junto do
cupom do cliente.

---

# Trilha C — Operacao

## C1 — Limpar empresas de teste da producao `P`

**Evidencia:** o banco de producao acumulou empresas criadas por testes de
migracao e desenvolvimento (92 registradas em sessao anterior; as suites de API
criam mais a cada execucao, com nomes como `Test Cardapio` e `Empresa A`).

**Por que importa:** producao com lixo de teste distorce qualquer metrica de
negocio e polui backup. E vai piorar assim que A1 fizer as suites rodarem
regularmente.

**O que fazer:**
1. Levantar e **mostrar ao dono** o que sera apagado antes de apagar
2. Backup antes (`pg_dump`), como ja foi feito no cutover
3. Apagar so o que for comprovadamente de teste — `delete from empresas` faz
   cascade
4. **Corrigir a causa:** as suites devem apontar para um projeto Supabase de
   teste ou para o Mongo local, nunca para producao

**Pronto quando:** producao so tem empresas reais, e rodar a suite nao cria mais
nenhuma la.

**Atencao:** operacao destrutiva em producao — confirmar com o dono antes.

---

**✅ LIMPEZA CONCLUIDA em 2026-08-18** (dono confirmou explicitamente antes da
execucao). 126 de 127 empresas em producao eram teste (`@teste.com`, nomes
`Restaurante Bella Vista`/`Pizzaria Napolitana`/`KDS Teste A/B`/`Caixa Teste`,
criadas entre 2026-08-10 e 2026-08-14). Processo:

1. Backup completo (todas as colunas, 127 registros) salvo antes de qualquer
   exclusao
2. Lista de candidatas mostrada ao dono com contagem exata; confirmacao
   explicita obtida antes de executar
3. Delete em 6 lotes de 25 via REST (`id=in.(...)`), 200/126 confirmados
4. Pos-delete verificado: producao com exatamente 1 empresa (`Tanelas FooD`,
   a real), 0 produtos orfaos (contagem total de produtos = contagem de
   produtos da empresa real)

**🟡 Causa raiz (passo 4 do "o que fazer") — parcialmente endereçada.** O
projeto **nao tem um Supabase de staging/teste separado** — e um unico
projeto multi-tenant (ver `project_restaurant_os_multitenancy` na memoria).
Rodar as suites com `DATABASE_PROVIDER=supabase` localmente *e* escrever em
producao, porque e o mesmo projeto. O estado atual (`.env` local com
`DATABASE_PROVIDER=mongo`) e seguro, mas e uma convencao, nao uma trava
tecnica — nada impede uma sessao futura (ex: um novo ciclo de validacao
"Supabase real", como a Fase 6B que provavelmente causou a poluicao original)
de apontar `DATABASE_PROVIDER=supabase` e repetir o problema.

Duas saidas possiveis, nenhuma executada agora (decisao de custo/infra do
dono, fora do escopo de um item `P`):
- Criar um segundo projeto Supabase dedicado a teste/staging (custo
  recorrente, mas isolamento real)
- Formalizar a convencao: `DATABASE_PROVIDER=supabase` local so em sessao
  supervisionada e curta, nunca como default, com um lembrete visivel (ex:
  comentario no `.env.example`)

---

## C2 — Multiplos caixas por empresa `M`

**Evidencia:** indice unico parcial garante **um caixa aberto por empresa**:

```sql
CREATE UNIQUE INDEX caixas_um_aberto_por_empresa
  ON caixas (empresa_id) WHERE status = 'aberto';
```

**Por que importa:** restaurante com balcao e delivery em PDVs separados nao
consegue operar. Limita exatamente o cliente que paga mais.

**O que fazer:** introduzir o conceito de ponto de venda (terminal), trocar o
indice para `(empresa_id, terminal_id)`, e associar cada venda ao terminal.
Manter o comportamento atual como caso de terminal unico, para nao quebrar quem
ja usa.

**Pronto quando:** dois operadores abrem caixas simultaneos em terminais
distintos, e cada fechamento confere so o proprio movimento.

---

## C3 — Supabase Auth + refresh de token `G`

**Evidencia:** auditado na Fase 8 (`docs/plans/PHASE-8-AUTH-AUDIT.md`), nunca
implementado. Hoje: JWT local, scrypt, token de 7 dias.

**Por que importa:** o risco escondido esta no frontend — o token do Supabase dura
**1 hora**, e `page.js` so le uma string do `localStorage`, sem refresh. Migrar
sem tratar isso desloga todo mundo a cada hora, e **passa em todo teste de API**.

**O que fazer:** seguir o audit. Adicionar refresh no wrapper `api()`, que ja e o
ponto unico por onde toda chamada passa. Fazer **depois** de A4 (E2E), que e o
unico jeito de pegar essa quebra antes do cliente.

---

## C4 — RLS realmente ativa `G`

**Evidencia:** 17 tabelas com RLS e 18 policies — mas o app usa `service_role`,
que **ignora RLS por completo**. O isolamento em execucao e 100% da camada de
aplicacao; as policies nunca sao exercidas.

**Por que importa:** e a defesa em profundidade que hoje nao existe de fato. Um
`empresa_id` esquecido numa query nova vaza dados entre clientes, e nada no banco
impede.

**O que fazer:** depende de C3 (exige token por usuario, nao `service_role`).
Fazer tabela por tabela, com teste de isolamento cross-tenant a cada passo.

**Cuidado:** policy incompleta se manifesta como **dado sumindo em silencio**,
nao como erro. Nunca fazer tudo de uma vez.

---

## C5 — Integracao iFood / Rappi `G`

**Evidencia:** nao existe. Pedido de marketplace entra manual.

**Por que importa:** hoje e o maior ralo de tempo operacional num restaurante
real — alguem digitando no sistema o que ja chegou no tablet do iFood, com o erro
de digitacao que vem junto.

**O que fazer:** spec propria, uma plataforma por vez. Comecar pelo iFood, que
tem a maior participacao.

---

## C6 — Migrations de schema nao fazem parte do deploy `M`

**Evidencia (achado em 2026-08-18):** `0019_estoque.sql`, `0020_custo.sql` e
`0021_cardapio_imagem.sql` foram escritas, commitadas, e o codigo que
depende delas foi implementado, revisado e "concluido" em sessoes
anteriores — mas as 3 migrations **nunca tinham sido aplicadas ao Supabase
de producao**. O EasyPanel faz auto-deploy do codigo da aplicacao no push,
mas migrations de schema exigem um passo manual separado
(`docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" < arquivo.sql`,
ver §5.1 do `HANDOFF.md`) que ninguem executou.

Resultado: Estoque (marcado completo 2026-08-14) e CMV (marcado completo
2026-08-17) ficaram **quebrados em producao** — qualquer leitura/escrita
tocando `produtos.custo`, `produtos.estoque_*`,
`transacoes.custo_total/receita_*` teria falhado contra o schema real —
durante dias, sem ninguem notar, porque a verificacao dessas features
rodou contra Mongo local ou contra uma sessao que testou "Supabase real"
mas nunca aplicou a migration antes de testar.

**Como foi descoberto:** o dono reportou nao achar o QR code do cardapio.
A investigacao achou um bug de UI (endpoint `/entregadores` com formato de
resposta inconsistente, corrigido em `65a5893`) — mas ao testar a correcao
em producao, bateu num ERRO DIFERENTE ao tentar subir a imagem do
cardapio: coluna inexistente. Só aí a auditoria manual do schema real via
`psql` revelou o problema completo.

**Corrigido nesta sessao:** as 3 migrations pendentes foram aplicadas
manualmente + `NOTIFY pgrst, 'reload schema'` pra forcar o PostgREST a
reconhecer as colunas novas. Verificado via `information_schema.columns` e
leitura de teste via REST.

**O que fazer (a causa raiz, nao so o sintoma):**
1. Todo "pronto quando" de feature que adiciona/altera schema deve incluir
   explicitamente "migration aplicada em producao E verificada via
   `information_schema`" — nao so "codigo commitado e testes passando"
2. Considerar um passo automatizado no processo de deploy (ou pelo menos um
   script `scripts/verificar-schema-producao.sh` que compara
   `information_schema.columns` esperado — derivado dos arquivos de
   migration — contra o real, e alerta se houver gap) em vez de depender de
   alguem lembrar
3. Relacionado a **C1**: a causa mais profunda (nenhum Supabase de staging
   separado) tambem contribui aqui — nao ha ambiente onde rodar a migration
   e testar ANTES de decidir se aplica em producao

**Pronto quando:** existe um jeito de saber, sem `psql` manual, se o schema
de producao esta alinhado com as migrations commitadas — hoje so se
descobre por acidente (como aconteceu aqui).

---

**✅ RESOLVIDO em 2026-08-18** (`scripts/migrate.mjs` + `docker/entrypoint.sh`).
Migrations passaram a rodar **automaticamente no boot do container**, antes do
servidor subir. O passo manual deixou de existir.

Como funciona:
- `docker/entrypoint.sh` roda `scripts/migrate.mjs` e so entao `exec node server.js`
- Tabela `public.schema_migrations` registra o que ja foi aplicado (necessario
  porque `0018_caixa.sql` usa `CREATE TABLE` sem `IF NOT EXISTS` — reexecutar
  quebraria)
- **Baseline automatica:** banco com schema mas sem tabela de controle (o caso
  de producao, migrada na mao ate agora) tem as migrations atuais marcadas como
  aplicadas, em vez de reexecutadas. Banco vazio roda tudo do zero.
- **Advisory lock** (`pg_advisory_lock`) serializa containers subindo juntos
- Cada migration em transacao propria; arquivo vai inteiro numa query (8 delas
  tem corpo `$$...$$`, split por `;` quebraria as funcoes atomicas)
- `notify pgrst, 'reload schema'` ao final — sem isso o PostgREST segue servindo
  o cache antigo e a coluna nova responde "could not find the column in the
  schema cache", exatamente o erro que o dono viu
- **Falha em migration derruba o boot (exit 1)**, de proposito: subir com schema
  errado foi o bug de origem. Excecao: `SUPABASE_DB_URL` ausente apenas AVISA e
  segue, para que a introducao deste runner nao derrube um deploy que ainda nao
  tem a variavel configurada
- `--dry-run` / `MIGRATE_DRY_RUN=1` inspeciona sem escrever (`yarn migrate:dry`)

**TLS:** o pooler do Supabase usa CA propria, entao a validacao padrao do Node
falha. Em vez de `rejectUnauthorized: false` (que aceitaria qualquer
certificado, inclusive de interceptador, numa conexao que carrega a senha do
banco e todo o dado dos clientes), a CA raiz do Supabase foi **fixada** em
`supabase/prod-ca-2021.crt` — baixada do endpoint oficial sobre HTTPS validado
por CA publica e conferida contra a raiz que o servidor apresenta (fingerprint
SHA-256 identico). Verificacao continua LIGADA.

**Validado antes de subir:** imagem construida localmente; runner exercitado
dentro do container (dry-run contra o banco real); os tres modos de falha
testados (sem URL -> avisa e segue; provider mongo -> pula; conexao ruim ->
exit 1). O primeiro build revelou um bug real que teria derrubado o deploy:
`NODE_PATH` nao afeta `import` de ESM, so `require()` de CommonJS — o driver
`pg` precisou ir para dentro de `/app/node_modules`.

**⚠️ Acao necessaria no painel:** `SUPABASE_DB_URL` precisa existir nas
variaveis de ambiente do EasyPanel. A aplicacao nunca precisou dela (usa a API
REST via `SUPABASE_URL` + service key), entao provavelmente **nao esta la** — e
sem ela o runner apenas avisa e segue, sem verificar nada.

**Ainda em aberto:** um comando que compare schema esperado vs. real sem subir
container (util em CI e para auditoria). O runner cobre o caminho do deploy,
que era o furo real.

---

# Trilha D — Sustentacao do codigo

## D1 — Extrair regra de negocio do route.js `M`

**Evidencia:** 81 endpoints e 2.203 linhas num arquivo, misturando dispatch HTTP,
autenticacao, autorizacao e regra de negocio. Ja cobrou tres vezes: o fix do KDS
quebrou comanda, dois blockers do Caixa passaram como completos, e o alerta de
estoque nunca funcionou.

**Por que importa:** o custo nao e estetico — e a taxa de erro. Cada feature nova
aumenta a chance de quebrar outra em silencio.

**O que fazer — incremental, nunca big-bang:**
1. O padrao ja existe e funciona: `lib/caixa.js`, `lib/cupom-dados.js` e
   `lib/custo.js` sao logica pura, sem banco e sem HTTP, com teste rodando em
   `node` puro em milissegundos
2. A cada feature nova, a regra nasce em modulo puro — **nunca** dentro do
   `route.js`
3. Ao tocar em regra existente por outro motivo, extrair aquele calculo
4. Alvos naturais: `computeComanda`, `computePedidoValores`, `normPedidoStatus`

**Pronto quando:** nenhuma formula de dinheiro mora dentro de um handler HTTP.

**Regra:** este item nao justifica sessao propria de refatoracao. Ele acontece
junto das outras.

---

## D2 — Quebrar o page.js em telas `G`

**Evidencia:** 2.920 linhas num componente unico, com apenas 3 componentes
extraidos (`kds`, `cupom`, `cardapio`).

**Por que importa:** mesmo motivo de D1, do lado do cliente. E ha um efeito
pratico: arquivo grande demais nao cabe em contexto, o que torna toda edicao
menos confiavel — inclusive as minhas.

**O que fazer:** uma tela por vez, comecando pela de maior atrito. Cada extracao
sai num commit proprio, sem mudanca de comportamento. Seguir o padrao ja usado em
`components/kds.jsx`.

**Cuidado:** fazer **depois** de A4 (E2E). Refatorar interface sem teste de
interface e trocar um risco conhecido por um desconhecido.

---

## Principios que valem para todo o programa

1. **Um item por vez, commitado.** Este documento sobrevive a sessao; contexto
   nao.
2. **Nunca refatorar sem rede.** D2 depende de A4. C4 depende de C3.
3. **Retrocompatibilidade nao e opcional.** Ha clientes reais em producao. B1 nao
   pode tirar acesso de quem ja usa.
4. **Operacao destrutiva em producao pede confirmacao do dono.** Vale para C1.
5. **Falha silenciosa e pior que erro.** Foi o que escondeu o alerta de estoque
   por semanas — e o proprio A2.
6. **Campo novo em entidade: confira se o handler usa lista explicita antes de
   supor que "propaga sozinho".** `POST /produtos` e `PUT /produtos/:id`
   montam o registro a partir de uma lista de campos — igual as funcoes
   atomicas do Postgres que ja tinham essa armadilha documentada (HANDOFF
   §4.3), so que aqui e puro JS, sem nem precisar de Postgres pra acontecer.
   Foi o que aconteceu aos tres campos de estoque por semanas, e quase
   aconteceu ao `custo` do CMV — pego so porque A1 rodou os testes antes da
   Task 5 ser executada. **Antes de adicionar qualquer campo a uma entidade
   existente:** `grep` pelos handlers POST/PUT dela e confirme que o campo
   novo esta na lista, ou que o handler usa o corpo inteiro
   (`{...entity}`/`insert(entity)`) em vez de campos nomeados um a um.
