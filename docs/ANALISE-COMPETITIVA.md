# Analise Competitiva — Restaurant OS

**Criado:** 2026-08-18
**Natureza:** analise de produto e posicionamento comercial, feita lendo o codigo
**Complementa:** `PROFISSIONALIZACAO.md` (saude tecnica) e `HANDOFF.md` (features)

---

## Veredito em uma frase

Voce construiu um **back-office de restaurante acima da media do mercado** e esta
posicionando ele como **produto de atendimento**. As duas pontas que o
posicionamento promete — WhatsApp e cardapio QR — sao casca sem motor. O caminho
para "tao bom quanto os melhores" nao passa por mais modulos de gestao: passa por
**fechar o loop do pedido**.

---

## 1. O que ja e melhor que a media (nao subestimar)

Isto nao e cortesia. Sao decisoes que a maioria dos concorrentes erra:

1. **Snapshot historico correto.** `nome`/`preco` congelados no item, custo
   congelado na `transacao`. A maioria dos sistemas recalcula relatorio a partir
   do preco atual e mente sobre o passado sem saber que esta mentindo.
2. **CMV com cobertura ao lado.** Mostrar "CMV 31% com 40% de cobertura" em vez
   de "CMV 31%" e honestidade de metrica que quase ninguem faz. Varios SaaS
   exibem um CMV lindo calculado sobre 3 produtos cadastrados.
3. **Multi-tenancy disciplinado.** `empresa_id` em toda entidade, RLS escrito,
   caminho de storage derivado do token e nunca do corpo da requisicao.
4. **Repository pattern com dois backends reais.** Raro de verdade, e vale em
   negociacao (portabilidade, nao ficar refem de fornecedor).
5. **Webhook do Mercado Pago exemplar** (`route.js:603`): assinatura verificada,
   dedupe idempotente, status reconsultado na fonte autoritativa. E como se faz.
6. **Cultura de documentacao.** `HANDOFF` + `PROFISSIONALIZACAO` + armadilhas
   catalogadas. E ativo, nao overhead — e o que permite retomar sem perder
   contexto e o que faz agente/dev novo produzir no primeiro dia.

---

## 2. Os tres achados que mudam a estrategia

### 2.1 🔴 O WhatsApp nao atende — ele arquiva

**Evidencia:** `/whatsapp/webhook` (`route.js:630-661`) recebe a mensagem,
acha/cria cliente, acha/cria conversa, grava a mensagem e **retorna**.
`sendWhatsappMessage` e chamado em **exatamente um lugar** do sistema inteiro
(`route.js:2177`): quando um humano digita a resposta na tela de atendimento.

Ou seja: o produto tem uma **caixa de entrada compartilhada de WhatsApp**, nao um
atendimento por WhatsApp. Zero automacao — nenhuma resposta automatica, nenhum
envio de cardapio, nenhum pedido criado a partir da conversa.

**Por que decide o jogo:** a Anota AI, referencia do mercado brasileiro neste
nicho, vende exatamente a parte que falta. O pitch dela e "seu atendente virtual
no WhatsApp 24h". O restaurante nao paga pela caixa de entrada — ele paga por
**nao precisar de alguem digitando as 22h de sexta**.

**Decisao do dono (2026-08-18):** o caminho escolhido e automatizar via n8n
(ja integrado como automacao de eventos de dominio, `lib/integrations/n8n.js`)
em vez de construir o atendente dentro do proprio `route.js`. Mantem a decisao
de arquitetura fora do codigo da aplicacao — o n8n orquestra, o Restaurant OS
continua so expondo os dados (cardapio, pedidos, conversas) que o fluxo
externo precisa. Fica pendente de execucao; nao muda o achado acima, so a
forma como ele vai ser resolvido.

### 2.2 🔴 O cardapio digital nao vende — ele exibe

**Evidencia:** `GET /cardapio/:slug` (`route.js:742`) devolve categorias e
produtos, e nada mais. `components/cardapio.jsx` tinha **89 linhas**: renderiza
a lista e filtra por categoria. **Nao existia carrinho, botao de pedir,
checkout, nem link de WhatsApp.** Nao existia nenhum endpoint publico de
criacao de pedido.

O proprio `HANDOFF.md` §11 diz: "Cardapio digital + QR na mesa ... e o tipo de
recurso que **vende** o SaaS". Esta certo.

**✅ Resolvido parcialmente em 2026-08-18** (commit `4d262ce`) — decisao do
dono: carrinho/checkout/pagamento ficam para uma fase 2 explicita (exige
cadastro de cliente e gateway), mas o cardapio deixou de ser so uma lista
estatica de produtos. O restaurante agora sobe uma **foto/poster do cardapio
impresso**, e o mesmo link/QR que ja existia (mesa + delivery, encaminhado
manualmente) leva direto pra ela. Por cima da imagem, um banner mostra os
itens marcados "indisponivel hoje" (reaproveitando o toggle `disponivel` ja
existente) — resolve o problema real de uma imagem estatica nao conseguir
reflete o que acabou na cozinha, sem exigir cadastro item a item no sistema.

O loop de venda (carrinho → pedido) continua fechado do lado de fora do
sistema — mas a barreira de entrada (cadastrar cada produto manualmente antes
de ter algo pra mostrar no QR) caiu. Fase 2 (auto-atendimento com pedido real)
segue como o proximo salto de valor, nao mais bloqueado por "nao tenho nem uma
imagem pra mostrar".

**A ironia produtiva permanece:** toda a maquina *depois* do pedido ja existe
e e boa — KDS, comanda, mesa, caixa, estoque, CMV, delivery.

### 2.3 ✅ O webhook do WhatsApp era publico e nao verificava nada

**Evidencia:** os dois webhooks vivem no mesmo arquivo, a 20 linhas de distancia.

| | Mercado Pago (`:603`) | WhatsApp (`:630`) |
|---|---|---|
| Assinatura | ✅ `verifyWebhook()` | ❌ nenhuma |
| Dedupe | ✅ `webhookEventsRepo` | ❌ nenhum |
| Fonte autoritativa | ✅ reconsulta o gateway | ❌ confia no corpo |
| Efeito | atualiza status de pagamento | **cria cliente + conversa + mensagem** |

**Impacto:** quem obtivesse um `empresa_id` (UUID — nao adivinhavel, mas vaza em
URL, print, ticket de suporte, ex-funcionario) injetava clientes e mensagens
falsas na caixa de entrada de um restaurante. O pior cenario nao era lixo no
banco: era **mensagem forjada aparecendo como se fosse de cliente real** dentro
da tela do operador.

**✅ Corrigido em 2026-08-18** (commit `14c4050`) — mesmo padrao do Mercado
Pago: `PUT /integracoes/evolution` gera um `webhookSecret` por empresa
automaticamente; `/whatsapp/webhook` passa a exigir `status==='configurado'`
e `?secret=...` batendo com o armazenado (`timingSafeEqual`, 401 caso
contrario) antes de tocar em qualquer dado; dedupe por `key.id` via
`webhookEventsRepo` (mesmo mecanismo do MP) evita duplicar cliente/conversa em
retry de rede. `GET /integracoes` passou a mascarar `apiKey`/`webhookSecret`
da Evolution tambem (so devolvia mascarado o do Mercado Pago antes). Verificado
com 9 checks manuais end-to-end + suite completa 8/8 (35/35 em
`backend_test_v3.py`, que ganhou um teste explicito provando a rejeicao sem
segredo).

**Ainda em aberto — sem rate limiting em lugar nenhum:** `/auth/login` (forca
bruta) e `/auth/register` (criacao ilimitada de tenants — e literalmente assim
que a producao acumulou 92 empresas de teste). Nao fazia parte deste achado
especifico; permanece candidato a proxima rodada.

---

## 3. Onde voce esta vs. os lideres

| Frente | Restaurant OS | Mercado |
|---|---|---|
| Gestao (KDS, caixa, estoque, CMV, comanda) | ✅ **forte, acima da media** | Saipos/Consumer tem; Anota AI nao tem profundidade |
| Cardapio digital QR | ⚠️ mostra (imagem ou lista); ainda sem carrinho | Goomer/Cardapio Web: QR → carrinho → cozinha |
| Pedido self-service | ❌ nao existe | padrao de mercado |
| WhatsApp automatico | ❌ inbox manual | Anota AI: **e o produto inteiro** |
| Integracao iFood/Rappi | ❌ digitacao manual | quase todos |
| Fiscal NFC-e | ❌ | Saipos/Consumer/Colibri (obrigatorio no segmento) |
| Billing / planos | ❌ flags nao bloqueiam nada | todos |
| Multi-PDV | ❌ um caixa por empresa | todos os de porte |
| Monitoramento de erro | ❌ | esperado |

**Leitura:** voce ganha na coluna que os concorrentes de atendimento nao tem
(gestao), e perde na coluna que eles usam pra vender (aquisicao de pedido).

---

## 4. Reordenacao proposta

O backlog atual (`A1 → A2 → C1 → B1 → A3 → D1 → B2`) e uma ordem de
**engenharia**: reduz risco antes de crescer. E defensavel e bem pensada. Mas
adia o que gera receita. Proposta em tres ondas:

### Onda 1 — Fechar o loop do pedido

1. **Pedido pelo cardapio QR (fase 2, decidida com o dono).** Imagem +
   banner de indisponiveis (✅ 2026-08-18) resolveu a barreira de entrada
   ("nao tenho nada pra mostrar no QR"). Falta o carrinho de verdade:
   `POST /cardapio/:slug/pedido` publico (rate limit + **preco validado no
   servidor**, nunca confiando no cliente) + cadastro de cliente + vinculo
   com mesa via QR. Continua o maior retorno por esforco do projeto — agora
   com o terreno preparado em vez de do zero.
2. ~~Assinatura + rate limit no webhook WhatsApp~~ — **assinatura feita
   (2026-08-18)**; rate limit em `/auth/login`/`/auth/register` segue
   pendente (ver §2.3).

### Onda 2 — Tornar vendavel

3. **B1 (flags que bloqueiam)** — pre-requisito de tudo comercial, ja
   corretamente identificado no `PROFISSIONALIZACAO.md`.
4. **B2 (onboarding)** — com o loop fechado, o onboarding tem um "aha" real:
   *"seu cardapio esta no ar, escaneie e faca um pedido de teste"*.
5. **A3 (monitoramento)** — com cliente pagante, nao da pra saber de queda pelo
   WhatsApp do dono.
6. **B3 (billing)**.

### Onda 3 — Moat e teto de mercado

7. **Atendimento automatico no WhatsApp.** Oportunidade real de diferenciacao:
   os concorrentes usam fluxo rigido de botoes. Um atendente com LLM entendendo
   *"manda dois X-tudo sem cebola e uma coca 2L"* em linguagem natural e
   diferenciacao verdadeira, nao paridade. Voce ja tem cardapio estruturado,
   cliente por telefone e criacao de pedido — falta o cerebro no meio.
8. **NFC-e (B4).** Decisao de **segmentacao**, nao de feature: sem isso voce
   vende para lanchonete/delivery MEI-Simples; com isso voce vende para
   restaurante estabelecido. Nao e o primeiro passo, mas define o teto de quem
   voce pode atender.
9. **iFood (C5).** Retencao, nao aquisicao. **Atencao a tensao de mensagem:** se
   o pitch e "fuja da comissao do iFood", integrar iFood e o argumento oposto.
   Os dois vendem — para clientes diferentes. Escolher conscientemente.

---

## 5. Riscos que nao estao no backlog atual

- **Restore de backup nunca testado.** Existe `backups/` e dumps foram feitos.
  Backup que nunca foi restaurado e hipotese, nao backup.
- **LGPD.** Voce armazena nome, telefone e endereco de **consumidor final de
  terceiros**. Vendendo B2B isso vira clausula contratual (retencao, exclusao a
  pedido, subprocessadores). Hoje nao ha politica nem mecanismo.
- **Ponto unico de falha.** Um container no EasyPanel. Restaurante nao pode cair
  20h de sexta. Sem redundancia nem plano de degradacao documentados.
- **Sem CI.** As suites passam, mas depende de alguem lembrar + Docker + servidor
  local. O item A1 resolveu "os testes nao rodavam"; falta "os testes sao
  obrigatorios".
- **`route.js` 2.286 linhas / `page.js` 3.005 linhas** ja custou **quatro**
  incidentes documentados: fix do KDS quebrou comanda, dois blockers do caixa
  passaram como completos, alerta de estoque nunca funcionou, e o CMV quase
  repetiu a armadilha. Nao e divida estetica — e gerador de defeito medido. D1/D2
  estao certos; eu subiria a prioridade deles.

---

## 6. Resumo executivo

**A pergunta "o que falta para ser tao bom quanto os melhores" tem uma resposta
curta:** os melhores nao sao melhores na gestao — voce ja ganha deles ali. Eles
sao melhores em **capturar o pedido**. Enquanto o pedido precisar de um humano
digitando, todo o resto do sistema (que e bom) fica dependente do gargalo mais
caro do restaurante.

Fechar o loop do pedido — QR com carrinho primeiro, WhatsApp automatico depois —
e o que transforma um bom back-office num SaaS que se vende sozinho.

**Atualizacao (2026-08-18):** dois dos tres achados avancaram no mesmo dia da
analise. O webhook do WhatsApp foi assinado e deduplicado (§2.3, sem mais
gap de seguranca). O cardapio QR deixou de ser uma parede em branco — imagem
do cardapio + banner de indisponiveis (§2.2) tira a barreira de entrada, com
o carrinho de verdade decidido para uma fase 2 separada (exige cliente +
pagamento). A automacao do WhatsApp (§2.1) fica a cargo do n8n, por decisao
do dono — arquitetura ja preparada para isso, execucao pendente.
