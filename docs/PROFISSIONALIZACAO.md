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

| # | Item | Trilha | Tam | Status | Commit |
|---|------|--------|-----|--------|--------|
| A1 | Consolidar e executar as suites de teste | Confianca | P | ⚪ | |
| A2 | Eliminar falhas silenciosas na UI | Confianca | P | ⚪ | |
| A3 | Monitoramento de erro em producao | Confianca | M | ⚪ | |
| A4 | Testes E2E dos fluxos criticos | Confianca | G | ⚪ | |
| B1 | Feature flags que realmente controlam acesso | Comercial | M | ⚪ | |
| B2 | Onboarding de novo restaurante | Comercial | M | ⚪ | |
| B3 | Billing e assinatura | Comercial | G | ⚪ | |
| B4 | Emissao fiscal (NFC-e) | Comercial | G | ⚪ | |
| C1 | Limpar empresas de teste da producao | Operacao | P | ⚪ | |
| C2 | Multiplos caixas por empresa | Operacao | M | ⚪ | |
| C3 | Supabase Auth + refresh de token | Operacao | G | ⚪ | |
| C4 | RLS realmente ativa | Operacao | G | ⚪ | |
| C5 | Integracao iFood / Rappi | Operacao | G | ⚪ | |
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
