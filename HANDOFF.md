# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-18 (contas a pagar/receber ganhou edicao —
gap de UI, o backend ja suportava — e recorrencia mensal com `repeticoes`;
rate limiting em /auth/login e /auth/register; monitoramento de erro em
producao — A3, codigo pronto e no-op ate a credencial do Sentry; contas a
pagar/receber com vencimento fechou as 4 pecas do pedido "relatorio
financeiro"; 5 problemas reportados em teste real corrigidos; feature flags
passaram a controlar acesso de verdade — B1. Ver §0.)

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

## 🌙 Trabalho autonomo de uma madrugada inteira — resumo

Sessao longa, sem parar pra confirmar cada passo (autorizado explicitamente
pelo dono). Nesta ordem: as 4 pecas do relatorio financeiro (DRE, ponto de
equilibrio, comparativo, margem por canal/produto, contas a pagar/receber),
5 bugs reportados em teste real, B1 (feature flags), A3 (monitoramento,
codigo pronto e no-op ate a credencial do Sentry), rate limiting em
login/registro, e — ja com o dono acordado e dando feedback ao vivo —
edicao de conta (gap de UI) e recorrencia mensal. Tudo testado (regressao
completa verde a cada commit) e no GitHub.

**Unica coisa que ainda precisa do dono:** o A3 (monitoramento de erro) tem
o codigo 100% pronto, mas so liga de verdade com uma credencial que so ele
pode criar (conta gratuita no Sentry). Ate la, e um no-op inofensivo. Passo
a passo em §6.2 e no item A3 do `PROFISSIONALIZACAO.md`.

## ⚠️ Armadilha nova: rate limiting e a suite de testes local

Desde `da9fac7`, `/auth/login` e `/auth/register` tem limite real. A suite
de testes local (dezenas de arquivos, centenas de `/auth/register`) NAO
sobrevive ao limite de 5/hora se o servidor local rodar com o limitador
ativo — ver `lib/rateLimit.js` e a nota tecnica completa na secao de rate
limiting mais abaixo. **Pra rodar a suite completa localmente:**

```bash
RATE_LIMIT_DISABLED=1 npm run dev:no-reload
```

`RATE_LIMIT_DISABLED` **nunca** deve ir para as variaveis do EasyPanel —
so existe pra desenvolvimento local. Pra testar o limitador de verdade,
rode `tests/backend_test_rate_limit.py` SOZINHO, contra um servidor SEM
essa variavel (ele manda `X-Forwarded-For` sintetico proprio em cada
requisicao, entao funciona com o limite ativo).

## O que mudou nesta sessao (2026-08-18, continuacao)

**Relatorio financeiro — 4 entregas em sequencia, cada uma commitada e
testada isoladamente:**

1. **DRE + ponto de equilibrio + despesas por categoria** (`1683c97`).
   Migration `0022` adiciona `transacoes.natureza` (`'fixa' | 'variavel' |
   null`, nunca inferida pelo servidor). Vocabulario fixo de categoria de
   despesa com natureza sugerida (`lib/financeiro.js`, `CATEGORIAS_DESPESA`)
   substitui o texto livre que fazia "Aluguel"/"aluguel" virarem categorias
   diferentes. DRE completo (receita → CMV → lucro bruto → despesas
   fixas/variaveis → lucro liquido) + ponto de equilibrio mensal
   (despesas_fixas / margem_de_contribuicao). Bug achado e corrigido no
   proprio desenvolvimento: a formula original devolvia `R$ 0` de ponto de
   equilibrio quando nao havia despesa fixa cadastrada — corrigido para
   `null`, porque despesa fixa zerada e quase sempre "nao classificado
   ainda", nunca "este restaurante nao tem aluguel". 8 testes
   (`tests/backend_test_dre.py`).

2. **Comparativo com o periodo anterior** (`97c3696`). Cada KPI do relatorio
   ganha a variacao contra a janela imediatamente anterior de mesma duracao
   (regra unica pra qualquer periodo, sem casos especiais por preset).
   `delta_percent` e `null` quando a base anterior foi zero — mostrar
   "+100%" ou "+infinito%" seria numero inventado; a tela cai pro valor
   absoluto. Percentual usa o modulo da base, entao prejuizo que diminui
   aparece como melhora (positivo), nao como piora. `inverter` pinta aumento
   de despesa/CMV% de vermelho — subir nem sempre e bom. Os dois lados
   (atual e anterior) passam pelo mesmo recorte de filtros, senao a
   comparacao mentiria. 7 testes (`tests/backend_test_comparativo.py`).

3. **Margem bruta por canal de venda** (`567188b`). Balcao, mesa, delivery e
   retirada, agrupados a partir do `custo_total`/`receita_com_custo` ja
   congelados em cada transacao (mesmos campos do CMV consolidado). Margem e
   BRUTA — so custo de mercadoria; aluguel/folha/energia NAO sao rateados
   por canal, porque rateio seria regra inventada por nos e numero inventado
   em relatorio financeiro e pior que numero ausente. Taxa de entrega fica
   em coluna propria, fora da receita de mercadoria (senao inflaria a
   margem do delivery). 7 testes (`tests/backend_test_margem_canal.py`).

4. **Margem por produto** (pendente de commit ao final desta sessao — ver
   nota abaixo). Ranking dos produtos por lucro bruto no periodo, nao por
   volume — o campeao de vendas pode ser o item que menos contribui pro
   lucro. **Diferenca deliberada em relacao ao DRE/canal:** usa o custo
   ATUAL do produto (`produtos.custo`), nao o congelado na venda, porque o
   custo so e congelado no nivel da VENDA INTEIRA (`transacoes.custo_total`),
   nao por item dentro dela — individualizar exigiria uma migration nova
   (custo congelado por item, que nao existe ainda). Isso significa que a
   soma deste ranking **pode nao bater** com o `lucro_bruto` do DRE se o
   custo de algum produto mudou dentro do periodo — e uma ferramenta de
   DECISAO ("no preco de hoje, o que compensa empurrar?"), nao de
   AUDITORIA do periodo passado, e a tela avisa isso explicitamente. 7
   testes (`tests/backend_test_margem_produto.py`).

Todas as 4 entregas somam ao export CSV do relatorio. Regressao completa
rodada apos cada commit (10 → 11 → 13 suites conforme os testes novos
entravam), sempre verde antes de subir.

**Feature flags que realmente controlam acesso — B1, o achado mais
importante do programa de profissionalizacao** (`46ad3d8` + `5af895d`). As
flags existiam desde sempre em `empresas.config.feature_flags`, apareciam
numa aba "Modulos" com badge Ativo/Em breve, e **nenhum dos 81 endpoints as
consultava**. Desligar "Estoque" na tela nao desligava o Estoque. A
autorizacao olhava so `can(papel, modulo)` — papel, nunca plano contratado.
Sem isso nao existe plano Basico e plano Pro, entao este item era
pre-requisito do billing (B3).

Agora ha um portao real (`lib/modulos.js` + `route.js`), ortogonal ao de
papel: `temModulo(empresa, 'caixa')` pergunta "a empresa contratou?",
`can(papel, ...)` pergunta "este usuario pode?" — as duas precisam passar.
Verificado na tela: desligar "Mesas & Comandas" some da navegacao na hora
(sem F5) e `GET /mesas` responde 403; religar devolve acesso e os dados
intactos.

**O perigo era maior que o documentado.** Auditando a producao antes de
escrever o gate: a unica empresa (`Tanelas FooD`) tinha `estoque: false` e
`caixa: false` gravados **e ao mesmo tempo** produtos com estoque habilitado
e caixas no historico. As flags nasceram erradas no signup precisamente
porque ninguem as lia. Um gate ingenuo teria tirado os dois modulos do
cliente no primeiro deploy. Tres camadas de defesa:
1. `temModulo()` so desliga com `false` explicito — ausente/null conta como
   ligado, pra que falta de dado nunca tire acesso de quem ja usa o modulo.
2. Migration `0023` liga os modulos entregues hoje em toda empresa
   existente. **So liga, nunca desliga** — testada numa transacao com
   `rollback` contra producao antes de ser commitada.
3. O signup passou a gravar `flagsPadraoSignup()` — o que o produto entrega
   hoje, nunca o que se pretende cobrar amanha.

A pedido do dono ("pode retirar o que nao estamos usando"), a vitrine dos 6
modulos "Em breve" (CRM, Campanhas, Fidelidade, Cashback, Multiunidades,
Billing) saiu da tela e da resposta de `GET /modulos` — sobrou so o que tem
endpoint de verdade por tras (Mesas&Comandas, Estoque, Caixa). As flags
continuam gravadas como `false` no signup, porque `temModulo()` trata flag
AUSENTE como ligada: apagar o registro faria um modulo futuro nascer aberto
no dia em que ganhasse portao. 10 testes (`tests/backend_test_modulos.py`).

## Contas a pagar/receber — fecha o pedido "relatorio financeiro"

Ultima das 4 pecas pedidas (comparativo, margem por canal e margem por
produto ja estavam no ar). Camada nova, separada de `transacoes`: uma
OBRIGACAO (o que ainda vai vencer) versus um FATO (o que ja aconteceu).
Migration `0025` cria a tabela `contas` (`tipo: 'pagar'|'receber'`,
`status: 'pendente'|'paga'|'cancelada'`, `vencimento` DATE, `transacao_id`).

**Decisao central:** uma conta pendente NUNCA aparece em nenhum numero do
relatorio (DRE, CMV, margem) — so ao ser marcada como paga/recebida, o que
cria a `transacao` de verdade (mesma categoria/natureza da conta) e liga
`transacao_id`. Contar como despesa um boleto que ainda nao saiu do bolso
inflaria o resultado com dinheiro que nao mudou de mao. Verificado ponta a
ponta: DRE mostrava `despesas_fixas: 0` com a conta pendente, passou a
mostrar o valor exato depois de paga.

`status: 'atrasada'` **nunca e gravado** — e sempre derivado na leitura de
`vencimento < hoje && status === 'pendente'` (`lib/contas.js`,
`statusEfetivo()`). Guardar como coluna exigiria um job diario para virar o
status sozinho; um dia sem esse job deixaria a lista inteira mentindo.

**Bug real de fuso horario, achado escrevendo o teste (nao teoria):**
`vencimento` e uma data pura (`"2026-08-18"`), que o motor JS sempre le como
meia-noite UTC. A primeira versao comparava contra "hoje" zerado em HORA
LOCAL do servidor — num fuso atras de UTC (ex: Brasil), um vencimento
genuinamente hoje caia antes da meia-noite local (convertida para UTC, mais
tarde que meia-noite UTC) e era classificado como atrasado por engano.
Corrigido comparando os dois lados em **calendario UTC**
(`Date.UTC(...)`), nunca em instante local. O front (`fmtDia()`) ja evitava
a armadilha simetrica (formatar `new Date(iso)` mostraria o dia errado a
oeste de UTC) formatando direto dos componentes da string.

Ao marcar como paga, o dialog pergunta a **data em que o dinheiro de fato
mudou de mao** (nunca assume "hoje") — um boleto vencido em junho e pago em
julho e despesa de julho no caixa, mesma logica de regime de caixa que o
resto do relatorio ja usa (`transacoes.data`, nao a data do pedido). Editar
uma conta ja paga/cancelada e bloqueado (409) — mesma regra de "pedido
concluido nao se edita".

Tela: aba propria em Financeiro, 4 cards (a pagar, a receber, vence em 7
dias, atrasadas), tabela filtravel por tipo/status, dialogo de nova conta
reaproveitando o vocabulario de categorias das despesas
(`CATEGORIAS_DESPESA`). 24 testes (`tests/backend_test_contas.py`).

## 5 problemas reportados testando o sistema ao vivo

Cada um investigado antes de corrigir — em dois casos o sintoma reportado
era so a ponta de um problema maior.

1. **CSV do relatorio abrindo com `#NOME?` no Excel.** Rotulos `"= Lucro
   bruto"` eram lidos como FORMULA (celula comecando com `=`). Alem do
   rotulo (trocado para `"(=)"`), o serializador generico tinha dois
   problemas mais serios: aspas dentro do texto quebravam a estrutura da
   planilha, e qualquer celula comecando com `=`/`+`/`-`/`@` e vetor de
   **injecao de formula** — nome de produto/cliente entra neste arquivo sem
   validacao. `csvCell()` agora escapa aspas e prefixa `'` (forcar texto).

2. **Pedido "Mesa" sem desconto e sumindo do kanban.** Mesma causa para os
   dois sintomas: "Mesa" no dialogo de Novo Pedido nao criava um pedido —
   abria uma COMANDA (desconto e controlado la, e o pedido so nasce ao
   fechar, ja "Concluido"). Decisao do dono: Mesa saiu do dialogo (comeca
   sempre pela tela Mesas) e Balcao+Retirada se fundiram em **"Para
   levar"**. Migration `0024` reclassifica o historico (testada com
   rollback contra producao: 14 balcao + 4 retirada → 18 para_levar,
   faturamento intacto). `normPedidoTipo()` traduz valores antigos em vez
   de recusar — cliente com JS em cache continua mandando `'balcao'` por um
   tempo apos o deploy.

3. **Atendente via faturamento, ticket medio, estoque e atendimento.**
   `dashboard`/`atendimento` saíram de `PERMISSIONS.ATENDENTE`. Achado no
   caminho: **`GET /dashboard/metrics` nao tinha checagem nenhuma** —
   bastava estar logado. Fechado no servidor, nao so escondido no menu
   (mesma logica do B1).

4. **Cursor saindo do campo de observacao a cada letra.** A `key` de cada
   item era `produto_id + observacao` — como a observacao muda a cada
   tecla, o React destruia e recriava o input. Cada item ganhou `_uid`
   local estavel (nunca enviado ao servidor). Testado digitando 23 letras
   seguidas: 0 perdas de foco.

5. **Barra de endereco/navegacao atrapalhando no celular.** Virou PWA
   (`app/manifest.js` + meta tags do iOS): atalho na tela inicial abre sem
   nenhuma das duas barras. Icone proprio gerado sem dependencia externa.
   `env(safe-area-inset-*)` reserva a area do notch; campos ganham
   `font-size: 16px` so em toque, porque abaixo disso o iOS da zoom
   automatico ao focar e nao volta sozinho.

## Contas a pagar/receber — edicao (gap de UI) e recorrencia mensal

Dois pedidos do dono, ja testando a feature ao vivo.

**1. "Nao e possivel editar uma conta depois de criada"** — o backend
(`PUT /contas/:id`) ja funcionava desde o commit original (testado,
`test_editar_conta_pendente_funciona`). O gap era so na tela: nenhum botao
chamava esse endpoint. `ContaDialog` ganhou modo edicao (prop `existente`),
prefilled com os dados atuais, `Tipo` desabilitado (backend nao aceita
trocar `tipo` via PUT — cancelar e recadastrar se precisar mudar).
`ContasTab` ganhou o botao de lapis ao lado de Pagar/Cancelar.

**2. Recorrencia (`repeticoes`)** — migration `0026` adiciona `serie_id`/
`serie_indice`/`serie_total` a `contas`. **Nao e um motor de recorrencia**:
`POST /contas` com `repeticoes: N` gera as N parcelas de uma vez, todas
como contas independentes ligadas so pelo `serie_id` (pra a tela rotular
"3 de 12"). Pagar, cancelar ou editar uma parcela nunca afeta as outras —
escopo deliberadamente menor que um motor de recorrencia de verdade, porque
o pedido foi "informar quantas vezes", nao "criar regra recorrente
continua".

Vencimento das parcelas seguintes: `adicionarMeses()` em `lib/contas.js`,
NUNCA aritmetica direta de `Date` do JS (que rolaria "31 de janeiro + 1 mes"
pra "3 de marco" em vez de clampar em 28/29 de fevereiro — testado
explicitamente, `test_repeticoes_clampa_dia_31_no_ultimo_dia_do_mes_destino`).

Sugestoes que ficaram de fora, anotadas mas nao pedidas: alerta de
vencimento no Dashboard (hoje so aparece dentro da aba Financeiro), editar
"esta parcela em diante" numa serie de uma vez, duplicar conta avulsa.

32 testes em `tests/backend_test_contas.py` (24 originais + 8 de
edicao/recorrencia).

## Rate limiting em /auth/login e /auth/register

Nenhuma das duas rotas tinha limite algum ate esta sessao — login sem
limite e forca bruta de senha; registro sem limite e criacao ilimitada de
tenants (71+ empresas de teste ja poluiram producao uma vez por isso, C1).

`lib/rateLimit.js`: janela fixa em memoria (um unico processo Node, sem
replicas — documentado no modulo pra migrar pra Redis/Postgres se isso
mudar). `/auth/register`: 5/hora por IP. `/auth/login`: 10/15min por
(IP, email) — conta toda tentativa, sucesso incluido, senao um atacante
alternando senha certa/errada nunca seria limitado.

**Achado tecnico relevante pra qualquer sessao futura nesta maquina:** o
Avast (antivirus) injeta `X-Forwarded-For: 127.0.0.1` em TODO trafego HTTP
local, mesmo sem proxy real e mesmo sem o cliente mandar o header —
confirmado com log temporario durante o desenvolvimento. Isso faz a suite
de testes inteira (que nao sabe desse header) compartilhar um unico balde
e se bloquear sozinha depois de 5 registros. `RATE_LIMIT_DISABLED=1`
(nunca em producao) existe exatamente por isso — ver o aviso no topo deste
arquivo (§0).

## Migrations automaticas — confirmado funcionando

Desde `8548470` (2026-08-18, sessao anterior), `docker/entrypoint.sh` roda
`scripts/migrate.mjs` no boot do container **antes** de `exec node
server.js`. Migration pendente e aplicada sozinha no deploy; migration que
falha **derruba o boot** de proposito, em vez de subir a app com schema
errado. `public.schema_migrations` registra o que ja foi aplicado — da
proxima migration em diante, basta commitar o `.sql` em
`supabase/migrations/`, sem passo manual nenhum.

**Achado tecnico nesta sessao:** `migrate.mjs --dry-run` rodado localmente
apos criar a migration `0022` acusou `0001_init.sql` como "editada desde que
foi aplicada" — falso positivo causado por `core.autocrlf=true` do Windows
convertendo o arquivo para CRLF no checkout, enquanto o blob do git (e o
container Linux que rodou o baseline) usam LF. `.gitattributes` ganhou
`*.sql text eol=lf` para fechar essa fresta — qualquer checkout novo, em
qualquer maquina, fica em LF.

**Historico da causa raiz (contexto, ja resolvido):** as migrations
`0019_estoque`, `0020_custo` e `0021_cardapio_imagem` ficaram commitadas por
dias sem serem aplicadas ao Supabase de producao, porque antes deste
mecanismo migrations eram um passo manual via `psql` que dependia de alguem
lembrar. Estoque e CMV estavam quebrados em producao, em silencio, ate o
dono esbarrar no erro `Could not find the 'cardapio_imagem_url' column`.
Detalhe tecnico completo no item **C6** do `PROFISSIONALIZACAO.md`.

## 📋 Dois backlogs, propositos diferentes

| Documento | Para que serve |
|---|---|
| **este arquivo** | features de produto — o que o restaurante ganha de novo |
| **`docs/PROFISSIONALIZACAO.md`** | saude tecnica e prontidao comercial — o que impede vender e o que impede mudar sem quebrar |

O programa de profissionalizacao e um **documento vivo com 15 itens**,
executavel ao longo de varias sessoes, cada um com evidencia no codigo e
criterio de pronto. Progresso: ✅ A1 → ✅ A2 → 🟡 C1 (producao limpa, causa
raiz sem trava tecnica) → ✅ C6 (migrations automaticas) → ✅ B1 (feature
flags) → proximo, a escolher entre A3 (monitoramento de erro), B2
(onboarding) ou D1 (extrair regra de negocio do route.js).

---

# ANEXO — Historico de features (KDS, Delivery, Caixa, Estoque)

As secoes abaixo documentam a implementacao original de cada modulo grande,
preservadas como referencia — todas **completas e no ar**. Se voce so quer
saber o estado atual do produto, pule para o §1.

## KDS — 11/11 tasks completas ✅ (2026-08-13)

Implementacao via subagent-driven-development
(`docs/plans/KDS-IMPLEMENTATION-PLAN.md`). Backend: migration `0016`, dual-auth
(usuario logado + token de TV), `GET /kds/pendentes` + `POST /kds/concluir`,
lifecycle de tokens (`GET/POST/DELETE /kds/tokens`). Frontend: `KDSPainel`,
`KDSTv`, `CozinhaPendentes`, tela de configuracao para gerar/revogar links.
40/40 + 32/33 (baseline) testes, build limpo, isolamento multi-tenant
verificado.

**Bug critico encontrado e corrigido em producao (2026-08-14):** cozinheiro
clicava "pronto" e o pedido ficava travado em "em_preparo" sem erro visivel.
Causa dupla: UI removia o item da lista otimisticamente antes de confirmar
sucesso (nunca recarregava depois), e o backend nao verificava se
`pedidoRepo.update()` de fato encontrou e atualizou a linha — `{ ok: true }`
mesmo quando o update falhava em silencio. Corrigido nos dois lados
(commit `34e374c`). **Armadilha para lembrar:** um fix de "verificar se
update() retornou algo" so vale se o metodo do repository realmente
devolve algo — Supabase exige `.select()` explicito na query, Mongo exige
checar `matchedCount`. Esse mesmo padrao voltou a aparecer no Caixa (ver
abaixo) e foi corrigido com o mesmo raciocinio.

## Delivery — 12/12 tasks completas ✅ (2026-08-13)

Migration `0017`: 6 colunas em `pedidos` (endereco, taxa, tempo estimado,
entregador, saiu_para_entrega_em) + tabela `entregadores`. CRUD completo de
entregadores, calculo `total = subtotal - desconto + acrescimo +
entrega_taxa`, UI com bloco de configuracao (taxa/tempo padrao) + selecao de
entregador no fluxo de pedido.

## Caixa — 14/14 tasks completas ✅ (2026-08-14)

Migration `0018`: abertura/fechamento com conferencia, sangria, suprimento,
estorno. Um caixa aberto por empresa por vez (indice unico parcial).

**Whole-branch review encontrou 2 bugs bloqueantes de producao, corrigidos
no mesmo dia:**
- `transacaoRepository` (Supabase): `unwrap()` chamado com assinatura errada
  (2 argumentos em vez de objeto desestruturado) fazia `findByCaixa` e
  `findByPedido` sempre devolverem `[]` — todo fechamento de caixa mostrava
  saldo curto pelo valor de TODAS as vendas do dia. Corrigido (`e97dbfa`).
- `comandaRepository.updateItemCampos()` nao retornava nada — o fix do bug
  critico do KDS (acima) checava `if (!updated)`, e sem retorno isso
  disparava sempre, fazendo todo clique "pronto" num item de comanda dar
  HTTP 500 mesmo com sucesso no banco. Corrigido (`d624507`).

**Racionalidade a lembrar:** os dois bugs sao a mesma classe de erro —
"verificar se a operacao teve efeito" so funciona se o metodo do repository
participa do contrato (devolve o que foi alterado). Ao adicionar essa
checagem num lugar, os OUTROS lugares que fazem update tambem precisam do
mesmo cuidado.

## Estoque — 12/12 tasks completas ✅ (2026-08-14)

Migration `0019`: rastreamento opt-in por produto (`estoque_habilitado`,
`estoque_quantidade`, `estoque_minimo`), baixa automatica na venda,
`listEstoqueBaixo()`. Badge de status (verde/amarelo/vermelho) na lista de
produtos, card de alerta no Dashboard.

**Nota importante:** o codigo ficou completo e "no ar" em 2026-08-14, mas a
migration `0019` so foi de fato aplicada ao banco de producao em
2026-08-18 (ver a secao de migrations automaticas acima) — quatro dias de
uma feature "concluida" que nao funcionava em producao, sem ninguem notar.

## Cardapio Digital + imagem — concluido (2026-08-18)

Cardapio publico com QR ja existia (mesa + delivery). Analise competitiva
(`docs/ANALISE-COMPETITIVA.md`) apontou que a pagina so listava produtos,
sem imagem nem indicacao de indisponibilidade. Fase 1 (feita): upload de
foto/poster do cardapio impresso (migration `0021`, bucket Storage
`cardapios` proprio, 5MB) + banner de itens "indisponivel hoje" reusando o
toggle `disponivel` ja existente. Fase 2 (carrinho + checkout + pagamento
publico) fica para depois — decisao de escopo, nao esquecida (ver roadmap).

## Webhook do WhatsApp sem verificacao — corrigido (2026-08-18)

`/whatsapp/webhook` criava cliente+conversa+mensagem so com `?tenant=<id>`
no corpo, sem nenhuma assinatura — diferente do webhook do Mercado Pago (no
mesmo arquivo) que ja validava origem e deduplicava. Quem obtivesse um
`empresa_id` injetava mensagem forjada na caixa de atendimento de qualquer
empresa. Corrigido com o mesmo padrao do Mercado Pago: `webhookSecret`
gerado automaticamente por empresa, exigido via `?secret=...`
(`timingSafeEqual`), dedupe por `key.id`.

## C1 — Limpeza de empresas de teste em producao (2026-08-18)

Auditoria encontrou 126 de 127 empresas com padrao de teste. Backup completo
salvo antes de excluir; lista mostrada e confirmada explicitamente pelo
dono antes da execucao; delete em 6 lotes via REST (`ON DELETE CASCADE`);
pos-delete verificado — producao com exatamente 1 empresa
(`Tanelas FooD`), 0 registros orfaos.

**Causa raiz nao 100% resolvida:** essas empresas surgiram porque o projeto
nao tem um Supabase de staging separado — e um unico projeto multi-tenant,
entao rodar as suites com `DATABASE_PROVIDER=supabase` localmente escreve
direto em producao. O `.env` local esta seguro (`mongo`) hoje, mas isso e
convencao, nao trava tecnica.

## Custo e Margem (CMV) — 9/9 tasks completas ✅ (2026-08-17)

Migration `0020`: `produtos.custo` + 3 campos em `transacoes`
(`custo_total`, `receita_com_custo`, `receita_base`), congelados no momento
da venda nos 3 pontos de gravacao (pedido concluido, comanda fechada,
comanda dividida com rateio por metodo de pagamento). `lib/custo.js`
(`computeCMV`) alimenta Dashboard e Relatorio. 4 invariantes que nao podem
ser perdidas:
1. Custo congelado na TRANSACAO, nao no item — preserva historia (mudar o
   custo amanha nao reescreve o CMV de hoje).
2. `produtos.custo` e `null`, nunca `0` por omissao — `null` fica fora do
   calculo e conta contra a cobertura; `0` e custo zero real (brinde).
3. Cobertura sempre ao lado do CMV — um CMV de 31% com 40% de cobertura nao
   e o mesmo que um CMV de 31% de verdade.
4. Estorno nao devolve custo — a comida foi produzida e perdida.

**Whole-branch review encontrou 1 issue importante:** o bloco `cmv` em
`GET /dashboard/metrics` nao tinha permission gate — ATENDENTE e COZINHA
recebiam custo/margem sem checagem de papel. Corrigido com o mesmo gate que
`/financeiro/relatorio` ja usava (`2544610`).

---

# 1. O que e o produto

**Restaurant OS** — SaaS de atendimento e gestao para restaurantes,
lanchonetes e similares, com WhatsApp como canal principal de atendimento.
Modulos: cardapio, pedidos (delivery/mesa/para_levar), mesas e comandas,
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
- **Portao de PLANO (feature flags) e ortogonal ao portao de PAPEL** (regra
  nova, desde B1): `temModulo(empresa, 'caixa')` pergunta se a empresa
  contratou; `can(ctx.papel, 'financeiro')` pergunta se o usuario pode. As
  duas checagens sao independentes e ambas precisam passar — nunca uma
  substitui a outra.

## 2.2 Contratos de dominio

`packages/domain/src/index.ts` — entidades e interfaces de repositorio
(TypeScript, **nao compilado**; o projeto nao tem `tsconfig`/`typescript`.
Serve como documentacao executavel do contrato). Ambos os backends satisfazem
exatamente as mesmas interfaces.

Entidades: `Empresa` (com `EmpresaFeatureFlags`, `EmpresaConfig`), `Usuario`,
`Categoria`, `Produto`, `Cliente`, `Pedido` (+`PedidoItem`), `Mesa`,
`Comanda` (+`ComandaItem`, `PagamentoResumo`), `PagamentoRegistro`,
`Transacao` (com `natureza`, `custo_total`, `receita_com_custo`,
`receita_base`), `Integracao`, `Conversa`, `Mensagem`, `Auditoria`. Mais
`BulkCreatable<T>` (carga em lote, usada pelo seed).

**Nota:** formas de resposta de RELATORIO (DRE, comparativo, margem por
canal/produto) nao entram aqui — sao calculadas sob demanda por modulos
puros (`lib/custo.js`, `lib/financeiro.js`), nao correspondem a uma entidade
persistida, e por isso ficam fora do contrato de dominio.

## 2.3 Implementacoes de repositorio

- `lib/repositories/mongo/` — **16 repositories** (backend default do codigo).
- `lib/repositories/supabase/` — **15 repositories** (o que roda no servidor).
- `lib/repositories/factory.js` — **escolhe o backend**. Unico lugar do
  sistema que sabe qual persistencia esta em uso.

`route.js` **nao conhece nenhum driver de banco**.

## 2.4 Autenticacao e autorizacao

- **Auth: JWT local** (HMAC-SHA256, `exp` em segundos, TTL 7 dias) + senhas
  com **scrypt** (N=16384, r=8, p=1, formato `salt:hash`). Ainda **nao**
  migrado para Supabase Auth — auditado na Fase 8, implementacao nao iniciada.
- **O `papel` NUNCA vem do token**: e relido do banco a cada requisicao, no
  portao unico de auth. Por isso revogar acesso e imediato.
- **RBAC: hardcoded** nos objetos `ROLES`/`PERMISSIONS` do `route.js` (50+
  checagens `can()`). As tabelas `papeis`/`permissoes` existem no Supabase com
  seed, mas **o app nao as le** — armadilha conhecida, nao "corrigir" sem
  decisao.
- **Feature flags (plano/modulo): `lib/modulos.js`**, desde 2026-08-18 (B1).
  `temModulo(empresa, chave)` — so `false` explicito desliga; ausente/null
  conta como ligado. Modulos configuraveis hoje: `mesas` (junto com
  `comandas`), `estoque`, `caixa`. Os demais (`crm`, `campanhas`,
  `fidelidade`, `cashback`, `multiunidade`, `billing`) existem so como flag
  gravada `false` no signup, sem endpoint nem tela — reservados pra quando
  forem implementados.
- Papeis: `OWNER`, `ADMIN`, `GERENTE`, `ATENDENTE`, `COZINHA`.
- **Frontend**: token em `localStorage['ros_token']`, `fetch` puro, sem
  logica de refresh (ver armadilha 14).

---

# 3. Multi-tenancy (regra critica do produto)

Toda entidade de dominio carrega **`empresa_id`**. Isolamento em **duas
camadas, sempre as duas**:

1. **Aplicacao**: toda query e escopada por `empresa_id` extraido do token.
2. **Postgres RLS**: tabelas com RLS habilitado e policies correspondentes.

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
  da venda. **Nunca** recalcular a partir do preco atual do produto. Custo
  (`produtos.custo`), diferente disso, so e congelado no nivel da VENDA
  INTEIRA (`transacoes.custo_total`), nao por item — e por isso que "margem
  por produto" usa custo atual, nao historico (ver §0).
- **`comanda.pagamentos`**: array embutido no Mongo (copia denormalizada); no
  Postgres **nao existe coluna** — a tabela `pagamentos` e a fonte unica.
- **Numeracao de pedido**: tabela `pedido_contadores` + funcao atomica por
  tenant (substituiu um `count()+1` com race condition).
- **Valores de pedido**: `total = subtotal - desconto + acrescimo (+
  entrega_taxa)`, calculado no Service. **Ajuste bloqueado (409) apos
  concluir**, porque nesse ponto o pedido ja virou receita em `transacoes`;
  corrigir depois disso exige lancamento no financeiro, nao edicao do pedido.
- **Logo/imagem do cardapio**: arquivos no Supabase Storage; URLs publicas
  guardadas em `empresas.logo` / `empresas.cardapio_imagem_url`.
- **Impressao de cupom**: NAO E CUPOM FISCAL (sem NFC-e/SAT). E comprovante
  de producao/atendimento via `window.print()` no navegador do caixa.
  Codigo em `lib/cupom-dados.js` (mapeamento puro) + `components/cupom.jsx`.
- **Natureza da despesa** (migration `0022`): `transacoes.natureza` e
  `'fixa' | 'variavel' | null`. Nunca inferida pelo servidor a partir da
  categoria — o dialog de lancamento manda o valor explicito, porque uma
  categoria tipicamente fixa pode ter um lancamento pontual variavel.
- **Feature flags** (migration `0023`): `empresas.config.feature_flags` e o
  unico lugar onde "a empresa contratou este modulo" vive. Ver §2.4.

## 4.2 Tabelas (principais, com `empresa_id`)

`usuarios`, `categorias`, `produtos`, `clientes`, `mesas`, `comandas`,
`comanda_itens`, `pedidos`, `pedido_itens`, `pagamentos`, `transacoes`,
`integracoes`, `conversas`, `mensagens`, `auditoria`, `webhook_events`,
`pedido_contadores`, `entregadores`, `caixas`, `caixa_movimentos`,
`kds_tokens`. Raiz do tenant: `empresas`. Catalogos globais: `papeis`,
`permissoes`. Controle de deploy: `schema_migrations` (nao tem `empresa_id`
— e infraestrutura, nao dominio).

## 4.3 Migrations (26 aplicadas, todas via `scripts/migrate.mjs` desde 2026-08-18)

```
0001_init.sql               0009_repository_support_functions.sql
0002_core_fixes.sql         0010_atomic_create_functions.sql
0003_pedido_numero_atomico  0011_migration_upsert_functions.sql
0004_mesas.sql               0012_pedidos_comanda_id.sql
0005_comandas.sql            0013_increment_conversa_patch_parcial.sql
0006_pagamentos.sql          0014_resync_contador_por_empresa.sql
0007_webhook_events.sql      0015_pedidos_desconto_acrescimo.sql
0008_conversas_mensagens.sql

0016_kds.sql                 0022_despesa_natureza.sql
0017_delivery.sql            0023_feature_flags_retrocompat.sql
0018_caixa.sql                0024_pedido_tipo_para_levar.sql
0019_estoque.sql              0025_contas.sql
0020_custo.sql                0026_contas_recorrencia.sql
0021_cardapio_imagem.sql
```

`0001` a `0015` dependem de `triggers.sql`/`policies_rls.sql`/`seed.sql`
rodando entre `0001` e `0002` — ordem completa e testada no `README.md`. A
partir de `0016`, cada migration e autocontida (idempotente,
`add column if not exists` / `create table if not exists`).

**Para adicionar schema:** basta commitar o `.sql` novo em
`supabase/migrations/`. O deploy aplica sozinho no boot do container — ver
§0. Nunca rodar `psql` manualmente; se precisar inspecionar sem escrever,
`yarn migrate:dry` (ou `DATABASE_PROVIDER=supabase node scripts/migrate.mjs
--dry-run`).

**Cuidado ao mexer em pedidos:** `create_pedido_com_itens()` e
`upsert_pedido_com_itens()` (Postgres, migrations antigas) usam **lista de
colunas explicita**. Coluna nova em `pedidos` exige reescrever as duas,
senao o valor e descartado em silencio.

**Migrations ja aplicadas sao imutaveis.** `migrate.mjs` calcula um checksum
SHA-256 do conteudo de cada arquivo; editar uma migration antiga dispara
aviso de "migration mudou desde que foi aplicada". Criar uma nova em vez de
editar. `.gitattributes` forca LF em `*.sql` para o checksum nao variar
entre um checkout Windows e o container Linux que roda em producao.

## 4.4 Switch de runtime (`DATABASE_PROVIDER`)

A escolha do backend vive so em `lib/repositories/factory.js`:

```bash
DATABASE_PROVIDER=mongo      # default do codigo (omitir tem o mesmo efeito)
DATABASE_PROVIDER=supabase   # o que roda no servidor
```

- Conferir o que esta ativo: `GET /api/health` -> campo `database`.
- **Sem fallback silencioso**: `supabase` sem credenciais **falha**, em vez de
  cair para o Mongo.
- **Sem modo hibrido**: misturar backends na mesma requisicao daria leitura
  inconsistente e quebraria as FKs do Postgres.
- Trocar exige reiniciar o processo.
- **Atencao:** rodar a suite de testes com `DATABASE_PROVIDER=supabase`
  localmente escreve DIRETO em producao — nao ha staging separado (ver C1
  no §0). O `.env` local fica em `mongo` por convencao, nao por trava
  tecnica.
- Detalhes: `docs/plans/PHASE-7-RUNTIME-SWITCH.md`.

---

# 5. Conexoes e integracoes

| O que | Onde | Credencial | Sem configuracao |
|---|---|---|---|
| **Supabase** (banco atual) | Projeto hospedado | `.env` / variaveis do EasyPanel | App falha explicitamente |
| **Supabase Storage** (logos, cardapio) | Mesmo projeto | Mesmas do Supabase | Endpoint responde 503 |
| **MongoDB** | Container local `ros-mongo-local` | `MONGO_URL`/`DB_NAME` | So usado com `DATABASE_PROVIDER=mongo` |
| **Evolution API** (WhatsApp) | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Retorna "nao configurado" |
| **n8n** | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Evento e ignorado |
| **Mercado Pago** | Externo | Por empresa, tabela `integracoes` | Retorna "nao configurado" |

## 5.1 Supabase — como conectar

- **Direct connection resolve para IPv6** e e inacessivel de varias redes.
  Usar o **Session Pooler** (`aws-0-us-east-2.pooler.supabase.com:5432`).
- A senha do banco contem `@`, que **precisa ser codificado como `%40`** na
  connection string.
- O painel do Supabase entrega a string com o literal `[YOUR-PASSWORD]`, que
  passa despercebido — copiar do `.env` local evita colar o placeholder.
- TLS: o pooler usa CA propria do Supabase. A CA raiz esta fixada em
  `supabase/prod-ca-2021.crt` (conferida por fingerprint SHA-256) —
  verificacao TLS continua **ligada**, nunca `rejectUnauthorized: false`.
- Nao ha `psql` instalado nesta maquina: rodar via
  `docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL"` **so para
  inspecao manual** — migrations de verdade rodam sozinhas (§4.3).
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

**Implanta automaticamente ao receber push na `main`.** Boot do container:
migra o schema primeiro (`entrypoint.sh` → `migrate.mjs`), so depois sobe o
servidor Node. Migration que falha derruba o boot de proposito.

**Nao usar** o `docker-compose.yml` da raiz: ele sobe postgres, evolution-api
e n8n juntos, duplicando servicos que ja existem. Aquele arquivo serve para
subir a stack inteira num VPS limpo.

**Nao ligar** o botao "Criar arquivo .env" na aba Ambiente — as variaveis ja
chegam como ambiente; ligar gravaria a service role key em arquivo dentro do
container.

## 6.2 Variaveis obrigatorias

`JWT_SECRET` (exclusivo do servidor), `DATABASE_PROVIDER=supabase`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CORS_ORIGINS`. Mais `SUPABASE_DB_URL`
(so para o migrator conectar via `pg`, a app em si nunca usa — vai por REST).

Sem `JWT_SECRET`, o app sobe mas responde `503 degraded` e recusa autenticar
(falha fechada, de proposito). Variavel nova so vale **apos reimplantar**.

**Opcionais (monitoramento de erro, item A3):** `SENTRY_DSN` (servidor) e
`NEXT_PUBLIC_SENTRY_DSN` (navegador — DSN e projetado pra ser publico).
Ausentes, o app funciona identico a hoje (no-op completo, sem chamada de
rede nenhuma). Para ativar: criar conta gratuita em sentry.io, criar um
projeto Node.js, copiar o DSN mostrado no onboarding, colar como
`SENTRY_DSN` nas variaveis do EasyPanel (e opcionalmente o mesmo valor como
`NEXT_PUBLIC_SENTRY_DSN`, se tambem quiser capturar erro do navegador),
redeploy. Detalhe tecnico completo no item A3 do `PROFISSIONALIZACAO.md`.

## 6.3 Supabase Storage

Bucket `logos` (publico, 1 MB, PNG/JPG/WEBP/SVG) e bucket `cardapios`
(publico, 5 MB, para a imagem do cardapio impresso), ambos criados via Admin
API. Caminho derivado do token (`{empresa_id}/...`), upload com `upsert` e
cache-buster `?v=` na URL.

## 6.4 Imagem

`docker/Dockerfile` multi-stage, saida `standalone`, com `HEALTHCHECK`
apontando para `/api/health`. Estagio extra (`migrator-deps`) instala `pg`
isoladamente e copia para dentro de `/app/node_modules` do estagio final —
ESM resolve import ali naturalmente, sem depender de `NODE_PATH` (que so
funciona para `require()` do CommonJS). `.dockerignore` exclui `.env` e
`backups/`, com excecoes explicitas para `scripts/migrate.mjs`,
`supabase/migrations/` e `supabase/prod-ca-2021.crt` (que precisam ir na
imagem apesar do padrao geral de ignorar).

---

# 7. Estado de cada frente

| Frente | Status |
|---|---|
| Migracao MongoDB → Supabase (Fases 1-8) | **Concluida** |
| Deploy | **No ar**, deploy automatico por push, migrations automaticas |
| KDS (11 tasks) | **Completo e no ar** |
| Delivery (12 tasks) | **Completo e no ar** |
| Caixa (14 tasks) | **Completo e no ar** |
| Estoque (12 tasks) | **Completo e no ar** (migration so aplicada em producao 2026-08-18) |
| Custo e Margem / CMV (9 tasks) | **Completo e no ar** |
| Cardapio digital + imagem | **Completo e no ar** (fase 1; carrinho/checkout ficam para fase 2) |
| Relatorio financeiro — DRE, ponto de equilibrio | **Completo e no ar** |
| Relatorio financeiro — comparativo periodo anterior | **Completo e no ar** |
| Relatorio financeiro — margem por canal | **Completo e no ar** |
| Relatorio financeiro — margem por produto | **Completo e no ar** |
| Relatorio financeiro — contas a pagar/receber | **Completo e no ar** — fecha o pedido |
| Contas a pagar/receber — edicao + recorrencia mensal | **Completo e no ar** |
| Pedido: tipos enxugados (delivery/mesa/para_levar) | **Completo e no ar** |
| Acesso do ATENDENTE restrito (sem financeiro/estoque) | **Completo e no ar** |
| PWA (instalar no celular, tela cheia) | **Completo e no ar** |
| Feature flags controlando acesso (B1) | **Completo e no ar** |
| Monitoramento de erro em producao (A3) | **Codigo no ar, no-op ate a credencial do Sentry** |
| Rate limiting em login/registro | **Completo e no ar** |
| Supabase Auth (implementacao) | **NAO INICIADA** |
| Realtime | **NAO INICIADO** |

## 7.1 Baseline de testes

`tests/run_all.py` descobre e roda toda suite `tests/backend_test_*.py`
automaticamente. Estado no fim desta sessao: **13 suites, todas verdes**
(a 14a, margem por produto, roda antes do commit final). Cada suite cria
empresas novas via `/auth/register` — rodar contra producao acumula tenant
de teste (ver C1 no §0).

## 7.2 Validacao de frontend

Playwright usado ativamente nesta sessao e nas anteriores para verificar
toda feature nova na tela real (nao so a API) antes do commit: DRE,
comparativo, margem por canal, margem por produto, e o ciclo completo de
ligar/desligar modulo (nav sumindo, 403 no fetch, religar restaurando).
O restante do frontend mais antigo (telas de Pedidos, Mesas, Atendimento)
segue sem validacao sistematica — maior lacuna de teste do projeto.

---

# 8. Ambiente local de desenvolvimento

Nao sobrevive a reboot. Para retomar:

1. `.env` ja existe na raiz (nao versionado).
2. Docker Desktop aberto, depois `docker start ros-mongo-local`.
3. `corepack enable` (necessario nesta maquina para o `yarn` resolver).
4. `yarn dev:no-reload` -> `localhost:3000`.
5. Testes: `BASE_URL=http://localhost:3000/api PYTHONIOENCODING=utf-8
   python tests/run_all.py` (roda tudo) ou um arquivo especifico em
   `tests/backend_test_*.py`.

**Armadilha:** rodar `yarn build` com o dev server no ar corrompe o `.next`
(`Cannot find module './chunks/vendor-chunks/next.js'`). Solucao: parar o
servidor, `rm -rf .next`, subir de novo.

---

# 9. Decisoes tomadas (nao renegociar sem confirmar)

1. **Itens de pedido/comanda**: tabelas relacionais com snapshot historico.
2. **Regra de negocio so no Service.** Postgres cuida de integridade e de
   funcoes mecanicas que recebem o valor ja calculado.
3. **Autenticacao migra para Supabase Auth** — auditada, a fazer depois.
4. **Um unico projeto Supabase** atende todas as empresas.
5. **Nunca mockar integracao externa.**
6. **Valor de pedido concluido nao se edita** — corrige-se por lancamento no
   financeiro.
7. **Custo/margem: nunca inventar um numero ausente.** `null` quando nao ha
   dado suficiente, mesmo que isso signifique mostrar "—" na tela. Regra que
   atravessa CMV, ponto de equilibrio, comparativo (`delta_percent`) e
   margem por canal/produto.
8. **Feature flag ausente/null conta como LIGADA, nunca desligada.** Falta
   de dado nao pode virar perda de acesso.
9. **Migrations sao imutaveis uma vez aplicadas.** Mudanca de schema sempre
   em arquivo novo, nunca editando um antigo.

---

# 10. Achados e armadilhas (para nao redescobrir)

Bugs e comportamentos reais encontrados **rodando** contra banco/servidor/
navegador de verdade — nao suposicao:

1. **`pedidos.comanda_id` nunca existiu como coluna** no schema inicial —
   migration `0012`.
2. **`pedidos_tipo_check` nao aceitava `'mesa'`** — migration `0012`.
3. **`jsonb_populate_record()` zera campos ausentes com NULL** em vez de
   aplicar o `DEFAULT` — funcoes atomicas usam lista de colunas explicita.
4. **Upsert em lote via PostgREST nao aplica `DEFAULT` por linha.**
5. **`supabase-js` remove chaves `undefined`** do corpo JSON — RPC com
   parametro obrigatorio sem default falha com `PGRST202`.
6. **Direct connection do Supabase e IPv6** — usar o Session Pooler.
7. **`papeis`/`permissoes` existem no banco mas o app nao le** — RBAC e
   hardcoded (mesma classe de bug do B1 com feature_flags: tabela/coluna que
   existe e ninguem consulta).
8. **`ON DELETE CASCADE` em `empresas`** limpa o tenant inteiro.
9. **Bulk insert de pedidos nao avanca `pedido_contadores`** — regra geral:
   toda carga em lote com numero explicito precisa realinhar o contador.
10. **`usuarios.id` e IMUTAVEL** — `auditoria.usuario_id` guarda ids sem FK.
11. **`service_role` IGNORA RLS por completo** — isolamento em runtime e
    100% aplicacao.
12. **O frontend nao tem refresh de token.** Sessao dura 7 dias; sem
    refresh, todo usuario cai apos expirar.
13. **Validacao de env no nivel do modulo quebra `next build`** — precisa
    ser lazy (avaliada em runtime, nao no import).
14. **EasyPanel: "Caminho de Build" nao aceita raiz vazia/`/`/`.`/`./`.**
    Usar `/app`, mas o CONTEXTO de build precisa continuar sendo a raiz.
15. **next-themes: `setTheme` muda de identidade a cada troca.** Nunca por
    numa dependencia de `useCallback`/`useEffect` — cria loop.
16. **Deploy novo exige Ctrl+Shift+R** em quem ja estava com o app aberto.
17. **`window.print()` abre dialogo NATIVO bloqueante** — Playwright que
    clica um botao cujo handler chama `print()` pode travar; testar a
    logica de dados separada da interacao real de clique.
18. **`if (!updated)` so funciona se o repository de fato devolve algo.**
    Supabase exige `.select()` explicito na query para o retorno nao vir
    vazio; Mongo exige checar `matchedCount`/`modifiedCount`. Apareceu 2x
    (KDS e Caixa) — ao adicionar essa checagem num metodo, conferir se o
    repository dos DOIS backends participa do contrato.
19. **Migrations nao fazem parte do deploy por padrao — precisam ser
    ligadas explicitamente ao boot.** Custou 3 features "completas" (Estoque,
    CMV, imagem do cardapio) rodando sem schema em producao por dias.
    Resolvido definitivamente com `entrypoint.sh` + `migrate.mjs` (§4.3).
20. **Checksum de migration muda entre Windows e Linux sem `eol=lf` no
    `.gitattributes`.** `core.autocrlf=true` do Windows converte `.sql`
    para CRLF no checkout; o container roda em LF. Sem forcar LF, todo
    `--dry-run` local acusa falso positivo de "migration editada".
21. **`POST /pedidos` espera `preco` explicito em cada item** — o servidor
    confia no que o cliente ja resolveu (o front carrega preco junto com a
    lista de produtos), nao busca pelo `produto_id`. Item sem `preco` no
    corpo gera pedido de subtotal zero, sem erro nenhum. Achado escrevendo
    testes de margem por canal/produto.
22. **Custo e congelado por VENDA, nao por ITEM dentro dela.**
    `transacoes.custo_total` e um agregado da venda inteira — nao existe
    "quanto custou este item especifico" de forma historica. "Margem por
    produto" usa custo ATUAL do catalogo por essa razao, e pode divergir do
    `lucro_bruto` do DRE quando o custo de um produto mudou dentro do
    periodo. Documentado explicitamente na tela para nao parecer bug.
23. **"Zero" e "nao classificado" sao estados diferentes que um calculo
    ingenuo confunde.** A formula original do ponto de equilibrio dividia
    `despesas_fixas / margem` sem checar `despesas_fixas > 0`, entao uma
    empresa sem NENHUMA despesa fixa classificada recebia "ponto de
    equilibrio: R$ 0" — uma mentira mais convincente (e mais perigosa) que
    mostrar "—". Mesma logica vale para `delta_percent` do comparativo
    (base zero -> `null`, nunca `+100%` nem `+infinito%`).
24. **Data pura (`"YYYY-MM-DD"`, sem hora) sempre e lida pelo JS como meia-
    noite UTC — comparar contra "hoje" em HORA LOCAL do servidor e bug
    garantido.** Achado em `lib/contas.js` (status "atrasada"): num fuso
    atras de UTC, um vencimento genuinamente hoje caia antes da meia-noite
    local (convertida para UTC) e era classificado como atrasado. Correcao:
    normalizar os dois lados para calendario UTC com `Date.UTC(...)` antes
    de comparar, nunca `setHours(0,0,0,0)` (que zera em hora LOCAL). O mesmo
    vale ao formatar de volta: `new Date(iso).toLocaleDateString()` mostra o
    dia ERRADO a oeste de UTC — formatar direto dos componentes da string
    (`fmtDia` em `app/page.js`) evita o espelho do mesmo bug no front.
25. **Editar `lib/repositories/factory.js` com o dev server no ar dispara
    hot-reload de TODO endpoint** (o arquivo e importado por `route.js`
    inteiro), derrubando conexoes por um instante. Uma suite de teste rodando
    em paralelo pega isso como falha de conexao, nao falha de logica —
    confundiu um resultado de teste real nesta sessao. Evitar editar
    dependencias transitivas de `route.js` enquanto uma suite esta em voo;
    se acontecer, rodar a suite de novo antes de confiar no resultado.

---

# 11. Pendencias e proximos passos

**Produto — pedido do dono, concluido nesta sessao:**

- [x] ~~Contas a pagar/receber com vencimento~~ — **DONE** (ver §0). Fecha
      as 4 pecas do pedido "relatorio financeiro".

**Produto — backlog conhecido, sem pedido explicito ainda:**

- [ ] **Cardapio QR com carrinho (fase 2)** — `POST /cardapio/:slug/pedido`
      publico + cadastro de cliente + pagamento. A fase 1 (imagem/banner)
      tirou a barreira de entrada; isto fecha o loop de venda de verdade.
- [ ] **Automacao do WhatsApp via n8n** — decisao do dono: fica no n8n, nao
      no `route.js`. Arquitetura ja publica eventos
      (`lib/integrations/n8n.js`); falta o fluxo do lado de la.
- [ ] **Ficha tecnica (insumos)** — faz o estoque funcionar para comida
      preparada, nao so revenda; fecharia o CMV para produtos compostos.
- [ ] **Rate limiting** em `/auth/login` e `/auth/register`.

**Tecnico — proximos itens do `PROFISSIONALIZACAO.md`, em ordem sugerida:**

- [ ] **A3 — Monitoramento de erro em producao.**
- [ ] **B2 — Onboarding de novo restaurante.**
- [ ] **D1 — Extrair regra de negocio do `route.js`** (2.500+ linhas hoje).
- [ ] **A4 — Testes E2E (Playwright) sistematicos**, cobrindo telas que hoje
      so tem verificacao ad-hoc.
- [ ] **Segundo projeto Supabase para staging** — eliminaria a causa raiz do
      C1 (rodar teste local `supabase` escreve em producao).
- [ ] **Implementar Supabase Auth** (`PHASE-8-AUTH-AUDIT.md`), incluindo
      refresh de token no frontend (armadilha 12).
- [ ] **Fazer o RLS valer** (trocar `service_role` por token de usuario).
- [ ] **Tornar o repositorio privado.** Hoje publico.
- [ ] **Dominio proprio.**

---

# 12. Commits recentes (sessao atual + anteriores)

```
567188b feat(relatorio): margem bruta por canal de venda
97c3696 feat(relatorio): comparativo com o periodo anterior
5af895d refactor(modulos): tira da tela os modulos que nao usamos
46ad3d8 feat(modulos): feature flags passam a controlar acesso de verdade (B1)
1683c97 feat(financeiro): DRE completa com despesas por categoria e ponto de equilibrio
25c9a0c docs: migrations automaticas confirmadas funcionando em producao
35d7b3f feat(estoque): alerta global com popup e som quando item atinge o minimo
8548470 feat(deploy): migrations rodam automaticamente no boot do container
7c55ef2 docs: achado critico — migrations 0019/0020/0021 nao estavam em producao
65a5893 fix: /entregadores retorna array/objeto puro, nao envelope
50e1a90 docs: handoff — C1 concluido, producao limpa
7691ca9 docs: registra limpeza de empresas de teste em producao (C1)
6afddef docs: handoff — 2026-08-18, A2 concluida, C1 em progress
41fb221 docs: marca A2 concluido no programa de profissionalizacao
e12abe8 fix: elimina falhas silenciosas na UI (A2, profissionalizacao)
7f40a6c docs: atualiza HANDOFF com sessao de 2026-08-18
d5da6b3 docs: registra decisoes e correcoes da analise competitiva (2026-08-18)
14c4050 fix(seguranca): webhook do WhatsApp exige assinatura e deduplica
4d262ce feat: imagem do cardapio digital + banner de itens indisponiveis
9d6202d chore: fecha gaps nao-bloqueantes apontados na revisao final da CMV
2544610 fix(seguranca): gate de permissao no bloco cmv do dashboard
1b2d493 test: suite de integracao de custo e CMV
75ef358 feat: CMV no relatorio financeiro e no export CSV
917800a feat: cards de lucro bruto e CMV no dashboard
458d2a9 feat: campo de custo no cadastro do produto, persistido nos dois sentidos
5add47c feat: bloco cmv no dashboard e no relatorio financeiro
488ac50 feat: apura e congela o custo nos tres pontos de venda
3019916 feat: modulo puro de apuracao de custo e CMV
ac17676 schema: custo em produtos e apuracao congelada em transacoes
34e374c fix: bug critico do KDS (pedido travado em em_preparo)
d624507 fix: updateItemCampos() do Supabase nao retornava o registro
e97dbfa fix: unwrap() com assinatura errada zerava consultas de caixa por pedido/caixa
```

(Historico completo, incluindo a migracao MongoDB→Supabase inteira,
disponivel via `git log`.)

---

# 13. Mapa de arquivos e documentos

**Governanca**
- `CLAUDE.md` — regras de operacao autonoma (ler antes de qualquer tarefa).
  Secao 18.1 define o formato obrigatorio deste handoff.

**Codigo — backend**
- `app/api/[[...path]]/route.js` — API inteira (Controller + Service).
- `packages/domain/src/index.ts` — contratos de dominio.
- `lib/repositories/mongo/` — 16 repositories.
- `lib/repositories/supabase/` — 15 repositories.
- `lib/repositories/factory.js` — switch `DATABASE_PROVIDER`.
- `lib/integrations/` — `evolution.js`, `n8n.js`, `supabase.js`,
  `storage.js`, `payments/`, `monitoring.js` (Sentry, no-op sem `SENTRY_DSN`).
- `lib/custo.js` — CMV, margem por canal, margem por produto (modulo puro).
- `lib/financeiro.js` — DRE, ponto de equilibrio, comparativo, categorias de
  despesa (modulo puro).
- `lib/modulos.js` — feature flags / gate de plano (modulo puro + funcoes de
  leitura sobre `Empresa`).
- `lib/contas.js` — contas a pagar/receber: `statusEfetivo` (atrasada
  derivada, comparacao em calendario UTC), `resumoContas` e
  `adicionarMeses` (recorrencia — soma meses em data pura, clampando no
  ultimo dia do mes destino). Modulo puro.
- `lib/rateLimit.js` — rate limiting em memoria (`checarLimite`,
  `ipDoCliente`). `RATE_LIMIT_DISABLED=1` so pra dev local — ver §0.
- `lib/caixa.js` — calculo de esperado/diferenca do caixa.
- `lib/cupom-dados.js` — mapeamento puro Pedido/Comanda -> dados do cupom.
- `lib/repositories/{mongo,supabase}/contaRepository.js` — CRUD de `contas`,
  registrado em `lib/repositories/factory.js`.

**Codigo — frontend**
- `app/page.js` — frontend inteiro (SPA).
- `app/manifest.js` — manifest do PWA (icones, `display: standalone`).
- `components/cupom.jsx` — renderiza e imprime o cupom (`window.print()`).

**Banco**
- `supabase/migrations/0001`…`0026` — lista completa e ordem no §4.3.
- `supabase/prod-ca-2021.crt` — CA raiz do Supabase, para TLS do migrator.

**Deploy**
- `docker/Dockerfile`, `docker/entrypoint.sh`, `.dockerignore` — imagem de
  producao (migra o schema, depois sobe o servidor).
- `scripts/migrate.mjs` — runner de migrations (idempotente, checksum,
  advisory lock, `--dry-run`).
- `docker-compose.yml` — stack completa para VPS limpo (**nao** usar no
  EasyPanel).

**Documentacao**
- `docs/operations/DEPLOY-EASYPANEL.md` — deploy passo a passo.
- `docs/PROFISSIONALIZACAO.md` — backlog de saude tecnica (ver §0).
- `docs/ANALISE-COMPETITIVA.md` — comparativo com concorrentes do nicho.
- `docs/plans/` — uma auditoria/relatorio por fase historica.
- `docs/ARCHITECTURE.md` (ADR-006), `docs/FOLDER_STRUCTURE.md`.

**Testes**
- `tests/run_all.py` — descobre e roda toda `tests/backend_test_*.py`.
- `tests/backend_test_dre.py`, `_comparativo.py`, `_margem_canal.py`,
  `_margem_produto.py`, `_modulos.py`, `_contas.py`, `_rate_limit.py` —
  relatorio financeiro, feature flags, contas a pagar/receber e rate
  limiting (sessao atual). `_rate_limit.py` precisa rodar SOZINHO, sem
  `RATE_LIMIT_DISABLED=1` — ver aviso no §0.
- `tests/test_monitoring.mjs` — modulo puro `lib/integrations/monitoring.js`,
  rodado direto (`node tests/test_monitoring.mjs`), fora do `run_all.py`
  (que so descobre `backend_test_*.py`).
- `tests/backend_test.py`, `_v2`, `_v3`, `_caixa.py`, `_kds.py`,
  `_custo.py`, `_cardapio.py`, `_estoque.py`, `_entregadores.py` —
  regressao dos modulos anteriores.

**Backups**
- `backups/` — dumps do Supabase. **No `.gitignore`** (pode conter dado
  real).
