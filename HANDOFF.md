# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-19, manha. **B2 — Onboarding guiado**
concluido e no ar (`0deb39d` + `8b78f26`): checklist de primeiros passos
substitui o texto de marketing no Dashboard ate a empresa se configurar;
seed de demonstracao parou de rodar sozinho no signup, virou botao
opcional. Achado real no processo: o signup JA NAO entregava mais o app
vazio (rodava seed automatico havia tempo) — a premissa original do B2
estava desatualizada. Ver §0.2.

O **deploy automatico do EasyPanel que tinha parado de disparar (~20min
de atraso) se resolveu sozinho** — Painel da Plataforma, pausar aviso,
fix da logo/PWA e texto do login, todos confirmados no ar. Ver §0.1.

Nesta mesma retomada, tambem no ar: Painel da Plataforma (assinaturas,
bloqueio, aviso de atraso) com pausa de aviso (cortesia sem perder o
controle do dono); bug real corrigido (logo/icones do PWA em 404 havia
dias); novo texto da tela de login. Antes disso: comercializacao — saida
da Emergent, balao de WhatsApp, tema claro padrao; E2E Playwright (A4);
contas a pagar/receber; rate limiting; A3. Ver §0.

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

## 0.0 ✅ RESOLVIDO SOZINHO: deploy automatico do EasyPanel tinha atrasado

Registrado enquanto acontecia, resolvido antes do dono precisar mexer em
nada — mantido aqui como referencia caso se repita.

Consultando `public.schema_migrations` em producao (via `pg` +
`SUPABASE_DB_URL`) as ~03:19 UTC de 2026-08-19, a ultima migration
aplicada ainda era `0027_assinaturas` (de 02:33:56) — 3 commits no
`main` (fix da logo, pausar-aviso com migration `0028`, texto do login)
ja estavam no GitHub havia mais de 20 minutos sem sinal de novo build,
bem mais lento que o normal desta sessao (2-3 min). Confirmado as
~10:10 UTC (quase 8h depois) que o deploy finalmente rodou: os 5
arquivos estaticos voltaram a 200 e `0028_assinatura_pausa_aviso`
apareceu em `schema_migrations`. Causa raiz nao identificada — pode ter
sido fila do EasyPanel, cache de build, ou algo do lado deles. Se
acontecer de novo, o metodo de diagnostico que funcionou foi exatamente
este: `curl` num arquivo estatico que so existe no fix mais recente +
consultar `schema_migrations` direto no banco (nenhum dos dois exige
acesso ao dashboard do EasyPanel, que esta fora do alcance desta sessao).

## 0.1 ✅ Painel da Plataforma — completo, testado e enviado

O dono pediu para sair no meio do trabalho; retomou depois. Backend
(`a8ad4aa`) e frontend (`2eebf01`) prontos, verificados e no `main` do
GitHub — o deploy automatico do EasyPanel deve aplicar a migration `0027`
na producao. Isto documenta o que foi feito e o que ainda falta (pouco).

**O que e:** resposta ao pedido do dono ("como criador preciso ter controle
total, de quem e quantas pessoas estao acessando o sistema... sistema de
alerta quando for vencer mensalidade... aviso humanizado de atraso...").
Depois de discutir o design com ele (ver decisoes abaixo), implementei o
backend inteiro: assinaturas (mensalidade que cada restaurante paga pra
ETNA), identidade de admin da plataforma separada por e-mail, bloqueio
manual total ou por modulo, e o aviso ao cliente dentro do proprio sistema
dele.

**Decisoes do dono, ja incorporadas no codigo (nao renegociar sem
confirmar de novo):**
- **Nunca avisar com antecedencia.** So depois que a mensalidade venceu.
  Citacao literal: *"nao avise com antecedencia o cliente, avise somente
  apos o atraso! gostei desse aqui"* — aprovando explicitamente a copy da
  faixa amber (dia 0-3: "pode levar 1 dia util"). Isso elimina qualquer
  tier de "vence em breve" — `lib/assinatura.js` so tem `avisoParaCliente()`
  retornando algo a partir de 1 dia de atraso.
- **Bloqueio e sempre MANUAL**, nunca automatico por atraso. O dono decide
  se bloqueia "alguns servicos" (modulo especifico) ou "acesso ao
  cliente" (empresa inteira) — nunca um robo desligando sozinho.
- **Admin tem acesso total aos dados** (nao so agregados) — o Painel da
  Plataforma le tudo (empresas, assinaturas, ultimo login).

**Estado do codigo — TUDO FUNCIONANDO, `git status` mostra 10 arquivos
novos + 7 modificados, NADA commitado ainda:**

1. `supabase/migrations/0027_assinaturas.sql` — 3 tabelas novas
   (`assinaturas`, `assinatura_pagamentos`, `plataforma_admins`), RLS
   habilitado sem policy (proposital, ver comentario no arquivo). **Testada
   em transacao com rollback contra producao** (mesma disciplina de sempre
   — nao ha staging). Ainda nao aplicada de verdade (so roda no boot do
   container quando este commit chegar na `main`).
2. `lib/assinatura.js` — modulo puro: `diasDeAtraso`, `statusEfetivo`
   (atrasada e sempre derivada, nunca gravada — mesma regra de
   `contas.status_efetivo`), `avisoParaCliente` (a escada amber/vermelho
   sem aviso antecipado), `resumoCarteira`. 14 testes unitarios em
   `test_assinatura_calculo.mjs`, **todos passando**.
3. Repositories novos (Mongo + Supabase, os dois lados):
   `assinaturaRepository`, `assinaturaPagamentoRepository`,
   `plataformaAdminRepository` — mais `list()` novo em `empresaRepository`
   e `listLogins()` novo em `auditoriaRepository` (os dois cross-tenant DE
   PROPOSITO, documentado no codigo, seguranca fica 100% em route.js).
   Registrados em `lib/repositories/factory.js` e nos contratos de
   `packages/domain/src/index.ts`.
4. `app/api/[[...path]]/route.js` — endpoints novos:
   - `GET /assinatura/status` (cliente, propria empresa, alimenta o aviso)
   - `GET /plataforma/eu` (frontend descobre se o usuario logado e admin)
   - `GET /plataforma/empresas` (lista todas + assinatura + ultimo acesso + resumo de carteira)
   - `PUT /plataforma/empresas/:id/assinatura` (criar/editar contrato)
   - `PUT /plataforma/assinaturas/:id/pagar` (registra pagamento, avanca `proximo_vencimento` com `adicionarMeses`)
   - `PUT /plataforma/assinaturas/:id/cancelar`
   - `PUT /plataforma/empresas/:id/bloqueio` (liga/desliga `empresas.ativo`)
   - `PUT /plataforma/empresas/:id/modulos/:chave` (variante admin do toggle que ja existia so pro OWNER)

   Identidade de admin: `plataforma_admins`, tabela SEPARADA por e-mail
   (nunca uma flag em `usuarios`) — comprometer a conta de um restaurante
   nunca vira acesso a plataforma. Auditoria de acao do admin grava no
   `empresa_id` da empresa ALVO (nao do admin), pra aparecer no historico
   que o proprio restaurante enxerga.
5. **Gap fechado: `empresa.ativo` agora e verificado em `/auth/login` E a
   cada requisicao autenticada** (nao so no login) — sem isso, bloquear uma
   empresa so surtiria efeito depois que o token de 7 dias expirasse.
   Busca a empresa em paralelo (`Promise.all`) com a busca do usuario, que
   ja acontecia em toda requisicao — nao e uma consulta nova, e a mesma
   viagem ao banco fazendo mais uma coisa.
6. `tests/backend_test_plataforma.py` — 11 testes de integracao, **rodados
   e verdes** contra o servidor local (`localhost:3000`), incluindo o caso
   que mais importa: sessao ja aberta e cortada NA HORA ao bloquear (nao
   so no proximo login).
7. **Frontend** (`app/page.js`, commit `2eebf01`): item de navegacao
   "Painel ETNA" (so visivel quando `GET /plataforma/eu` confirma admin —
   `Crown` icon), tela `PainelPlataforma` (resumo de carteira + tabela de
   empresas + dialogos de configurar assinatura/registrar pagamento/
   bloquear), e `AvisoAssinatura` no topo do Dashboard do cliente
   (banner amber/vermelho com botao direto pro WhatsApp da ETNA).

**Verificado:**
- `node --check` em todos os arquivos novos/editados — sintaxe ok.
- `node test_assinatura_calculo.mjs` — 14/14 passou.
- `python -m pytest tests/backend_test_plataforma.py -v` — 11/11 passou.
- **Regressao completa (`tests/run_all.py`): 16/17 suites verdes.** A unica
  excecao (`backend_test_rate_limit.py`) e o comportamento ESPERADO quando
  o servidor roda com `RATE_LIMIT_DISABLED=1` (precisa rodar sozinho,
  contra servidor sem essa variavel — ver aviso no topo do §0). Isso
  importa porque o gate de auth novo (`empresa.ativo` a cada requisicao)
  mexe no caminho de TODA rota autenticada do sistema, nao so das novas —
  as outras 16 suites passando confirma que nada quebrou.
- **Verificado ponta a ponta via Playwright** contra o servidor local:
  admin ve "Painel ETNA" na nav e um usuario comum nao ve; configurar
  assinatura com vencimento passado mostra "atrasada" na hora na tabela;
  registrar pagamento avanca o vencimento em exatamente 1 mes e volta pra
  "em dia"; o aviso no Dashboard do cliente muda de amber ("em aberto")
  pra vermelho ("atrasada") exatamente no dia 4 de atraso, com a copy
  aprovada pelo dono; bloquear corta login novo **E** sessao ja aberta na
  mesma hora (reload joga de volta pra tela de login); desbloquear
  devolve tudo. Dados de verificacao criados e removidos do Mongo local
  ao final — nao ficou lixo de teste.
- Commitado e enviado: `a8ad4aa` (backend) + `2eebf01` (frontend), `git
  push` feito — o deploy automatico do EasyPanel deve pegar e aplicar a
  migration `0027` em producao.

**O que falta:**
1. Ver §0.0 — nada mais avanca em producao ate o deploy automatico voltar
   a funcionar.
2. Opcional, sem pedido explicito: paginacao na tabela do Painel da
   Plataforma — hoje lista TODAS as empresas sem paginar; inofensivo com 1
   cliente real em producao hoje, mas o dev local acumulou 2000+ empresas
   de teste ao longo das sessoes e a tela renderizou todas sem quebrar
   (so confirma que funciona, nao que escale bem visualmente com volume
   grande).

**✅ JA FEITO — e-mail do dono promovido em producao.** Confirmado direto
no banco (`select * from plataforma_admins`): `tanelas.jr@gmail.com` ja
esta la, `ativo: true`, e ja existe um `usuario` com esse e-mail na
empresa real (`Tanelas FooD`, papel `OWNER`). Assim que o login normal
funcionar, o item "Painel ETNA" aparece na navegacao — nao precisa de
nenhum passo a mais.

## 0.1.1 Pausar aviso ao cliente (cortesia) — completo, testado e no ar

Pedido do dono, no mesmo dia: *"preciso ter a possibilidade de pausar o
aviso informativo de pagamento, caso eu queira dar um mes de cortesia"*.

**Decisao de design, escolhida explicitamente pelo dono entre 2 opcoes
que apresentei** ("conceder cortesia" vs. "pausar aviso"): a pausa **NAO
mexe no vencimento real**. A assinatura continua contando como
"atrasada" no Painel da Plataforma (entra em "valor em atraso") — o dono
nunca perde o proprio controle sobre quem deve, mesmo perdoando o aviso
que o cliente ve. Reaproveita 100% da maquina de status ja existente:
`statusEfetivo()` fica intocado de proposito, so `avisoParaCliente()`
ganha um curto-circuito (`aviso_pausado_ate`, `lib/assinatura.js`).
Passada a data, o aviso volta sozinho no dia seguinte — sem robo, sem
estado "pausa ativa/inativa" pra alguem esquecer de desligar.

- migration `0028`: `assinaturas.aviso_pausado_ate` (date, nullable).
  Testada com rollback contra producao.
- `PUT /plataforma/assinaturas/:id/pausar-aviso` — `{ate: "YYYY-MM-DD"}`
  pausa, `{ate: null}` cancela antes do prazo.
- Frontend: botao "Pausar aviso" na tabela do Painel da Plataforma
  (so quando ha assinatura), dialogo com aviso explicito de que o
  vencimento nao muda, e indicador "pausado até DD/MM" ao lado do
  badge "atrasada" — o dono sempre ve os dois fatos juntos.
- 4 testes unitarios novos (`test_assinatura_calculo.mjs`, 18 no total) +
  3 de integracao (`backend_test_plataforma.py`, 14 no total). Regressao
  completa 16/17 verde (rate_limit e a excecao sempre esperada).
  Verificado ponta a ponta via Playwright: pausar esconde o aviso do
  cliente mesmo com atraso real; painel do dono continua "atrasada";
  remover a pausa traz o aviso de volta na hora.
- Commits: `3dbaac9` (backend) + `f91c467` (frontend, ver §0.1.3) —
  **enviados, deployados e confirmados em producao**.

## 0.1.2 Bug real corrigido: logo e icones do PWA davam 404 em producao

Achado direto (nao teoria): o dono reportou a logo quebrada na tela de
login; `curl` contra producao confirmou `404` em `/etna-logo.png`,
`/etna-simbolo.png`, `/icon-192.png`, `/icon-512.png` e
`/apple-touch-icon.png`. Causa raiz: `next.config.js` usa
`output: 'standalone'`, e essa saida **NAO inclui `public/` automaticamente**
— precisa de um `COPY` explicito no Dockerfile (mesmo motivo pelo qual
`.next/static` ja tinha o seu proprio `COPY` uma linha acima). O
Dockerfile nunca ganhou essa linha porque, quando foi escrito, o projeto
de fato nao tinha pasta `public/` — um comentario dizia isso
explicitamente, e ninguem voltou pra atualizar o Dockerfile quando a
pasta passou a existir (icones do PWA, depois a logo ETNA). Effeito real:
esses 5 arquivos estao quebrados em producao ha DIAS, sem que ninguem
percebesse ate esbarrar visualmente num `<img>` quebrado.

Corrigido com `COPY --from=builder --chown=nextjs:nodejs /app/public
./public` (commit `b7bbe01`). **Nao foi possivel validar com um build
Docker local** — o Avast intercepta TLS dentro do container nesta
maquina (mesma classe de interferencia ja documentada para
`X-Forwarded-For`, ver §0 sobre rate limiting), entao `yarn install` e
`apk add` falham com "unable to verify the first certificate"/"TLS:
server certificate not trusted" mesmo com `--network=host`. O fix segue
o padrao oficial do Next.js e sera confirmado direto em producao — ver
§0.0, ainda nao deployado.

## 0.1.3 Novo texto da tela de login

Pedido do dono, texto de marketing proprio para a tela de login (nao
confundir com o `DashboardHero`, que fica DEPOIS do login — sao textos
diferentes, em telas diferentes, ambos pedidos pelo dono em momentos
distintos desta sessao). Substituiu o texto generico original
("A plataforma definitiva para gestão de restaurantes"). Estrutura:
overline + headline + subtexto + tags de modulo + 3 beneficios com
emoji (🍽️⚡📱), no painel escuro `hidden lg:flex` de
`app/page.js` (`AuthScreen`). Verificado visualmente via Playwright em
1440×900 — cabe sem overflow. Commit `f91c467`.

## 0.1.4 Onboarding guiado (B2) — completo, testado e no ar

Pedido do dono: qual proximo item do backlog tecnico atacar depois do
Painel da Plataforma. Escolhido entre B2 (onboarding), D1 (extrair regra
de negocio do route.js) e C4 (RLS realmente ativa) — os outros dois
foram descartados por razao concreta: D1 o proprio backlog diz que "nao
justifica sessao propria"; C4 depende de C3 (Supabase Auth), que ainda
nao foi feito.

**Achado real que mudou o design:** a evidencia original do item B2 no
`PROFISSIONALIZACAO.md` dizia "o signup entrega o app vazio" — falso.
`seedEmpresa()` ja rodava automaticamente em TODO `POST /auth/register`
havia tempo, entao qualquer checklist de "cadastre sua primeira
categoria" apareceria pronto sem o dono ter feito nada. Resolvido:
`POST /auth/register` parou de semear; virou `POST /empresa/seed-demo`,
sob demanda — a propria opcao "quero ver com dados de exemplo" que o
backlog ja pedia, so que descoberta como pre-requisito, nao acrescimo
opcional.

**Checklist final — 4 itens, cada um DERIVADO de dados reais**
(`GET /onboarding/status`, nunca uma flag "concluido" gravada em algum
lugar — mesma disciplina de status derivado do resto do sistema):
1. Cadastrar categoria
2. Cadastrar produto **com custo preenchido** (nao so "um produto
   qualquer" — o seed de demonstracao nunca preenche custo, de proposito,
   entao mesmo rodando o seed esse item continua pendente ate o dono
   preencher de verdade)
3. Configurar mesas (item omitido inteiro se o modulo `mesas` estiver
   desligado — `temModulo(empresa,'mesas')`, mesmo padrao de sempre)
4. Registrar a primeira venda — trocou "configurar formas de pagamento"
   do backlog original (nao fazia sentido: os 4 metodos ja nascem
   ligados no signup, nada fica pendente ali) pelo proprio criterio de
   sucesso que o `PROFISSIONALIZACAO.md` define para o B2.

**Onde aparece:** `OnboardingChecklist` substitui o `DashboardHero` de
marketing no topo do Dashboard enquanto `completo: false` — quem acabou
de se cadastrar precisa de guia, nao de pitch de venda. Cada item tem
botao "Ir" que navega direto pra tela certa (`destino` vem do backend).
Botao "Ver com dados de exemplo" chama o seed sob demanda e recarrega a
pagina inteira (mais simples que invalidar cada pedaco de estado
espalhado pelos componentes).

**Blast radius real no processo de implementar:** parar o seed
automatico quebrou a suposicao de 6 arquivos de teste legados
(`backend_test.py`, `_v2`, `_v3`, `_caixa`, `_custo`, `_kds`) que sempre
assumiram dados de demonstracao prontos logo apos o registro. Corrigido
chamando `POST /empresa/seed-demo` explicitamente no setup de cada um —
restaura o mesmo estado inicial que sempre tiveram, sem mudar o que cada
teste verifica. Achado por regressao real (nao suposicao): rodei a suite
completa DEPOIS de tirar o seed automatico e vi exatamente quais suites
quebravam.

10 testes novos (`tests/backend_test_onboarding.py`) + regressao completa
17/18 verde (rate_limit e a excecao sempre esperada). Verificado via
Playwright: empresa nova nasce com Dashboard zerado e o checklist
visivel; "Ir" no item categoria navega pro Cardapio; "Ver com dados de
exemplo" povoa a empresa e fecha 3 dos 4 itens (produto com custo
continua pendente, como projetado); rodar o seed duas vezes da 409.
Commits: `0deb39d` (backend) + `8b78f26` (frontend).

## 0.2 Pendente do pedido de comercializacao (5 itens, 4 no ar)

O dono pediu 5 coisas numa unica mensagem (ver §0.3 para o que ja saiu):
logo ETNA no login, remover Emergent, balao de WhatsApp, controle
total/assinaturas (item 0.1, quase pronto) e sugestoes de melhoria (dadas
em conversa, nao pedido de implementacao).

**Decisao em aberto, nao decidida ainda:** o dono ofereceu arquivos de logo
de qualidade melhor depois do primeiro upload ("inseri a logo com melhor
qualidade na pasta caso queira usar!"). Avaliados e **descartados por
enquanto**: `Copilot PNG.png` tem o mesmo defeito do arquivo original
(fundo xadrez gravado no pixel, sem alfa real) e o texto "ETNA" em azul
marinho escuro, que sumiria contra o painel escuro do login.
`Ercio Projeto - kittl.png` **ainda nao foi inspecionado visualmente**. Nao
foi pedido para trocar de novo — so revisitar se o dono trouxer o assunto.

## 0.3 🌙 Trabalho autonomo de uma madrugada inteira — resumo

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

## Testes E2E (Playwright) dos 5 fluxos criticos — A4 (`3f9e829`)

`e2e/` novo: `login`, `pedido`, `comanda`, `caixa`, `kds` — os 5 fluxos que o
`PROFISSIONALIZACAO.md` marcava como sem cobertura sistematica.
`.github/workflows/e2e.yml` roda contra **MongoDB efemero, nunca Supabase**
(sem `SUPABASE_*` no ambiente do CI, de proposito — nao ha staging, entao
CI jamais pode tocar producao). Achados reais escrevendo os testes:
- `playwright.config.js`: o viewport customizado precisa vir DEPOIS do
  spread de `devices['Desktop Chrome']`, senao o preset do device
  sobrescreve silenciosamente para 1280x720.
- O formulario de login nao tem `<Label for=...>` ligado ao `<Input>`
  (gap de acessibilidade pre-existente, documentado e nao corrigido so
  para o teste) — os testes usam `getByPlaceholder(...)`.
- `POST /pedidos` **exige `nome` explicito por item** (mesma regra de
  nunca derivar do `produto_id` que ja valia para `preco` — achado nº 21
  do §10). O helper `criarPedido()` nao mandava; um item some sem nome no
  card do KDS ate ser corrigido.

## Comercializacao — logo, saida da Emergent, WhatsApp, tema claro (`ee7ec3a`, `195bd7b`)

Pedido do dono como criador/vendedor do produto, nao como usuario de um
restaurante:

1. **Logo ETNA na tela de login** (`ee7ec3a`). Os JPGs originais tinham o
   fundo xadrez GRAVADO no pixel (sem alfa real) — qualquer remocao
   automatica teria comido as letras, porque a borda anti-aliased do texto
   e cinza identico ao xadrez. O dono forneceu um PNG com transparencia de
   verdade; `public/etna-logo.png`/`etna-simbolo.png` foram gerados via
   `sharp`, recortados pelo bounding box real do canal alfa (nunca "no
   olho"). Ver §0.2 para os arquivos de logo mais recentes que o dono
   ofereceu depois — ainda nao decidido se trocam.
2. **Saida da Emergent** (`ee7ec3a`). Referencias ao prototipo que iniciou
   o projeto removidas de `components/ui/chart.jsx` (comentarios de lint
   mortos, sem config correspondente) e `docs/plans/PHASE-6B-SUPABASE-REAL.md`
   (wording historico preservado, so o nome do vendedor trocado). Pasta
   `lib/constants/testIds/` (nao usada por nada, confirmado por grep)
   apagada com aprovacao explicita.
3. **Balao de WhatsApp comercial** (`ee7ec3a`). `BotaoWhatsApp` flutuante
   em toda tela (comecando pelo login), `wa.me/5591982934763` com mensagem
   pre-preenchida indicando a origem do clique. Sem dependencia de CDN
   (SVG inline). `env(safe-area-inset-bottom)` evita sobrepor a barra de
   gestos do iOS.
4. **Tema claro como padrao** (`195bd7b`). Pedido explicito: *"quero que o
   site abra na cor branca, e nao na cor preta como e hoje"*. Trocado em
   TRES lugares que precisavam concordar: `ThemeProvider` (front,
   `defaultTheme`), o valor gravado no signup de empresa NOVA
   (`appearance.tema`), e a empresa real do dono em producao (ja existia
   antes da mudanca de default, precisou de update manual pontual).
5. **Boas-vindas no Dashboard** (`195bd7b`). Texto de marketing pedido pelo
   dono ("Sua operacao mais simples...") — **importante nao confundir com
   a tela de login**: o dono corrigiu explicitamente no meio do pedido
   ("me refiro a tela apos o login!"), entao o componente `DashboardHero`
   fica no topo do `Dashboard()`, nao no `AuthScreen`. E cabecalho da
   pagina — nao substitui os cards/graficos que ja existiam ali.

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
- **`empresas.ativo` tambem e relido a cada requisicao** (nao so no login,
  desde o Painel da Plataforma — §0.1). Sem isso, bloquear uma empresa so
  surtiria efeito quando o token de 7 dias expirasse. Busca a empresa em
  paralelo com a busca do usuario (`Promise.all`), reaproveitando a viagem
  ao banco que ja acontecia — nao e uma consulta nova por requisicao.
- **Admin da PLATAFORMA (a ETNA) e identidade separada, por e-mail**:
  tabela `plataforma_admins`, nunca uma flag em `usuarios`. Um usuario
  sempre pertence a uma empresa (`usuarios.empresa_id NOT NULL`); marcar o
  dono como "super admin" ali vazaria a plataforma inteira se aquela conta
  fosse comprometida. Sem endpoint de auto-promocao — o unico jeito de
  virar admin e um insert direto no banco. Ver §0.1.
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
`kds_tokens`, `contas`, `assinaturas`, `assinatura_pagamentos`. Raiz do
tenant: `empresas`. Catalogos globais: `papeis`, `permissoes`. Da
PLATAFORMA, sem `empresa_id` (ver §2.4): `plataforma_admins`. Controle de
deploy: `schema_migrations` (tambem sem `empresa_id` — infraestrutura, nao
dominio).

**`assinaturas`/`assinatura_pagamentos` (migration `0027`, pendente de
commit — ver §0.1) NAO sao `contas`.** `contas` e o que o RESTAURANTE deve
(fornecedor, aluguel); `assinaturas` e o que o restaurante deve PARA A
ETNA. Dominios e donos diferentes, nunca misturar num relatorio.

## 4.3 Migrations (28 commitadas — `0027`/`0028` aplicam sozinhas quando o deploy destravar, ver §0.0 — via `scripts/migrate.mjs` desde 2026-08-18)

```
0001_init.sql               0009_repository_support_functions.sql
0002_core_fixes.sql         0010_atomic_create_functions.sql
0003_pedido_numero_atomico  0011_migration_upsert_functions.sql
0004_mesas.sql               0012_pedidos_comanda_id.sql
0005_comandas.sql            0013_increment_conversa_patch_parcial.sql
0006_pagamentos.sql          0014_resync_contador_por_empresa.sql
0007_webhook_events.sql      0015_pedidos_desconto_acrescimo.sql
0008_conversas_mensagens.sql

0016_kds.sql                 0023_feature_flags_retrocompat.sql
0017_delivery.sql            0024_pedido_tipo_para_levar.sql
0018_caixa.sql                0025_contas.sql
0019_estoque.sql              0026_contas_recorrencia.sql
0020_custo.sql                0027_assinaturas.sql
0021_cardapio_imagem.sql      0028_assinatura_pausa_aviso.sql
0022_despesa_natureza.sql
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
| Testes E2E Playwright (A4) | **Completo e no ar**, CI rodando contra Mongo efemero |
| Comercializacao — logo ETNA, saida da Emergent, WhatsApp, tema claro, boas-vindas | **Completo e no ar** |
| Painel da Plataforma (backend + frontend — assinaturas, bloqueio, admin por e-mail) | **Completo e no ar** (`a8ad4aa` + `2eebf01`), verificado via Playwright — ver §0.1 |
| Pausar aviso ao cliente (cortesia) | **Completo e no ar** — ver §0.1.1 |
| Novo texto da tela de login | **Completo e no ar** — ver §0.1.3 |
| Fix: logo/icones do PWA 404 em producao | **Completo e no ar** — ver §0.1.2 |
| Aviso de atraso na tela do cliente | **Completo e no ar** (banner amber/vermelho no Dashboard) |
| Onboarding guiado (B2) — checklist + seed sob demanda | **Completo e no ar** (`0deb39d` + `8b78f26`) — ver §0.1.4 |
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
9. **Aviso de mensalidade atrasada nunca antecipa o vencimento** — so a
   partir de 1 dia de atraso, decisao explicita do dono (§0.1). Nao
   reintroduzir um tier de "vence em breve" sem confirmar de novo.
10. **Bloqueio de acesso (empresa inteira ou modulo especifico) e sempre
    MANUAL** — nenhum robo desliga uma empresa sozinho por atraso.
11. **Identidade de admin da plataforma vive numa tabela separada por
    e-mail (`plataforma_admins`), nunca numa flag em `usuarios`.** Sem
    endpoint de auto-promocao, de proposito.
12. **Pausar o aviso ao cliente (cortesia) nunca mexe no vencimento real
    nem no `statusEfetivo`.** Decisao explicita do dono, escolhida entre
    duas opcoes apresentadas: a assinatura continua "atrasada" no Painel
    da Plataforma mesmo com o aviso pausado — o dono nao pode perder o
    proprio controle sobre quem deve so por conceder uma cortesia.
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
26. **`output: 'standalone'` do Next.js NAO inclui `public/` sozinho —
    precisa de `COPY` explicito no Dockerfile**, sempre, mesmo que
    `public/` nao existisse quando o Dockerfile foi escrito originalmente.
    Ficou faltando desde que a pasta passou a existir (icones do PWA,
    depois a logo ETNA): 5 arquivos deram 404 em producao por dias, sem
    ninguem perceber, ate um `<img>` quebrado aparecer na tela. Corrigido
    em `b7bbe01` — ver §0.1.2. Regra geral: toda vez que uma pasta nova
    de assets estatico for criada, conferir se o Dockerfile de producao
    precisa de um `COPY` novo, nao so assumir que "ja funciona".
27. **Build Docker local nesta maquina falha por causa do Avast** —
    mesma classe de interferencia de rede ja documentada para
    `X-Forwarded-For` no rate limiting (§0), agora tambem quebrando TLS
    de `yarn install` e `apk add` DENTRO do container
    (`unable to verify the first certificate` / `TLS: server certificate
    not trusted`), mesmo com `docker build --network=host`. Mudancas no
    Dockerfile nesta maquina nao podem ser validadas com `docker build`
    local — a validacao real acontece no build do EasyPanel, apos o
    deploy (ver §0.0 para o problema paralelo do deploy nao estar
    disparando no momento em que isto foi escrito).

---

# 11. Pendencias e proximos passos

**Produto — pedido do dono, concluido nesta sessao:**

- [x] ~~Contas a pagar/receber com vencimento~~ — **DONE**. Fecha as 4
      pecas do pedido "relatorio financeiro".
- [x] ~~Logo ETNA, saida da Emergent, balao de WhatsApp, tema claro,
      boas-vindas~~ — **DONE e no ar**.

- [x] ~~Painel da Plataforma (backend + frontend) + aviso de atraso ao
      cliente~~ — **DONE, verificado via Playwright, commitado
      (`a8ad4aa` + `2eebf01`) e enviado ao GitHub**. Ver §0.1.
- [x] ~~E-mail do dono promovido em `plataforma_admins` em producao~~ —
      **DONE**, confirmado direto no banco. Ver §0.1.
- [x] ~~Pausar aviso ao cliente (cortesia)~~ — **DONE, testado via
      Playwright, commitado (`3dbaac9` + `f91c467`) e enviado ao
      GitHub**. Ver §0.1.1.
- [x] ~~Novo texto da tela de login~~ — **DONE, commitado (`f91c467`) e
      enviado ao GitHub**. Ver §0.1.3.
- [x] ~~Fix: logo/icones do PWA 404 em producao~~ — **DONE, commitado
      (`b7bbe01`) e confirmado no ar**. Ver §0.1.2.
- [x] ~~Todos os itens acima confirmados em producao~~ — o deploy que
      tinha atrasado se resolveu sozinho. Ver §0.0.

**Tecnico — pedido do dono, concluido nesta sessao:**

- [x] ~~B2 — Onboarding guiado (checklist + seed sob demanda)~~ —
      **DONE, testado via Playwright, commitado (`0deb39d` + `8b78f26`)
      e no ar**. Ver §0.1.4.

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
- [x] ~~A4 — Testes E2E (Playwright) sistematicos~~ — **DONE**, ver `e2e/`.
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
8b78f26 feat(onboarding): frontend do checklist guiado (B2)
0deb39d feat(onboarding): checklist guiado + seed de demo sob demanda (B2) — backend
2edcb06 docs: handoff — pausar aviso, fix da logo/PWA, texto do login; alerta de deploy travado
f91c467 feat(plataforma): frontend da pausa de aviso + novo texto da tela de login
3dbaac9 feat(plataforma): pausar aviso de atraso ao cliente (cortesia) — backend
b7bbe01 fix(deploy): copia public/ para a imagem — logo e icones do PWA davam 404 em producao
798419a docs: handoff — Painel da Plataforma completo (backend + frontend), verificado via Playwright
2eebf01 feat(plataforma): frontend do Painel da Plataforma e aviso ao cliente
a8ad4aa feat(plataforma): controle total do dono — assinaturas, bloqueio manual e aviso humanizado de atraso
195bd7b feat(ux): tema claro como padrao + boas-vindas no Dashboard
ee7ec3a feat(marca): logo ETNA na tela de login, WhatsApp comercial e saida da Emergent
3f9e829 test(e2e): suite Playwright dos 5 fluxos criticos + CI (A4)
0bbe408 feat(contas): edicao (gap de UI) e recorrencia mensal
da9fac7 feat(seguranca): rate limiting em /auth/login e /auth/register
4d9ab33 feat(A3): monitoramento de erro em producao — codigo pronto, no-op sem DSN
c45a081 feat(financeiro): contas a pagar/receber com vencimento
2681dc5 fix: 5 problemas reportados em teste real (CSV, pedido, acesso, cursor, PWA)
03159aa docs: reescreve HANDOFF.md por completo — retrato atual do projeto
6d539dc feat(relatorio): margem por produto (lucro bruto, ranking)
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
- `lib/assinatura.js` — mensalidade do SaaS (ETNA <- restaurante):
  `diasDeAtraso`, `statusEfetivo`, `avisoParaCliente` (escada sem aviso
  antecipado), `resumoCarteira`. Modulo puro.
- `lib/repositories/{mongo,supabase}/assinaturaRepository.js`,
  `assinaturaPagamentoRepository.js`, `plataformaAdminRepository.js` —
  idem.
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
- `supabase/migrations/0001`…`0028` — lista completa e ordem no §4.3.
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
  limiting. `_rate_limit.py` precisa rodar SOZINHO, sem
  `RATE_LIMIT_DISABLED=1` — ver aviso no §0.
- `tests/backend_test_plataforma.py` — Painel da Plataforma, 11 testes
  verdes. Promove admin inserindo direto no Mongo local (`pymongo`) — nao
  existe endpoint de auto-promocao de proposito, entao o teste do caminho
  feliz precisa desse atalho so-local, mesmo espirito de
  `RATE_LIMIT_DISABLED`.
- `test_assinatura_calculo.mjs` — 18 testes puros de `lib/assinatura.js`
  (14 do status/aviso + 4 da pausa), mesmo padrao de
  `test_custo_calculo.mjs`/`test_caixa_calculo.mjs`.
- `tests/backend_test_onboarding.py` — B2 (onboarding), 10 testes:
  empresa nasce vazia, cada item do checklist fecha com o dado certo,
  seed sob demanda (cria, bloqueia rodar 2x, so OWNER/ADMIN).
- `e2e/` (Playwright) — `login`, `pedido`, `comanda`, `caixa`, `kds`.
  `playwright.config.js`, `.github/workflows/e2e.yml` (CI contra Mongo
  efemero, nunca Supabase).
- `tests/test_monitoring.mjs` — modulo puro `lib/integrations/monitoring.js`,
  rodado direto (`node tests/test_monitoring.mjs`), fora do `run_all.py`
  (que so descobre `backend_test_*.py`).
- `tests/backend_test.py`, `_v2`, `_v3`, `_caixa.py`, `_kds.py`,
  `_custo.py`, `_cardapio.py`, `_estoque.py`, `_entregadores.py` —
  regressao dos modulos anteriores.

**Backups**
- `backups/` — dumps do Supabase. **No `.gitignore`** (pode conter dado
  real).
