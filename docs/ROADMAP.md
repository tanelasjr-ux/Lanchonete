# Roadmap — Restaurant OS

Ultima revisao: 2026-08-13

Ordem acordada com o dono do projeto. Cada item numerado e um ciclo proprio
(spec -> plano -> execucao). Os itens marcados "acao do dono" nao sao codigo.

---

## Entregue

| # | Item | Quando |
|---|------|--------|
| 1 | Impressao de cupom (cozinha + cliente) | 2026-08-12 |
| 2 | Kitchen Display System (KDS) | 2026-08-13 |
| 3 | Delivery completo (endereco, taxa, tempo, entregador) | 2026-08-13 |

---

## Proximo

### 1. Caixa — EM ANDAMENTO

Abrir e fechar caixa, sangria, suprimento, conferencia de valores e
**estorno de venda**.

Inclui duas correcoes que sao pre-requisito e vivem no mesmo codigo:

- **Forma de pagamento na transacao.** Hoje `transacoes` nao guarda o metodo
  de pagamento, e uma comanda paga com dois metodos e gravada com apenas o
  primeiro (`route.js:1635`). Sem isso, nem a conferencia de caixa nem o
  grafico de pizza dos relatorios fecham.
- **Estorno de venda.** O codigo ja diz que o caminho correto para corrigir
  uma venda concluida "e um lancamento de estorno/ajuste no financeiro"
  (`route.js:1135`), mas esse lancamento nao existe como funcionalidade.

Spec: `docs/superpowers/specs/2026-08-13-caixa-design.md`

### 2. Repositorio privado — acao do dono

Produto comercial com codigo-fonte publico. Tornar privado e autorizar o
EasyPanel a clonar. Cinco minutos, risco real.

### 3. Backup do Supabase — acao do dono

Confirmar que existe backup automatico e **testar uma restauracao**. Se o
banco cair, o restaurante para. Verificar antes de qualquer feature nova.

### 4. Isolamento multi-tenant real (RLS)

Hoje o app usa `service_role`, que ignora RLS por completo. As 18 policies
existem mas nunca sao exercidas — o isolamento e 100% da camada de aplicacao.
Uma query que esqueca o `empresa_id` vaza dados entre restaurantes e nada no
banco impede.

Com um cliente so, o risco e teorico. **Fazer antes de entrar o segundo
restaurante pagante.**

### 5. Relatorios e analytics

Grafico de pizza por forma de pagamento, relatorio por data e por mes para
auditoria e balanco, ranking de produtos mais vendidos.

Depende do item 1 (forma de pagamento correta na origem).

### 6. Sessao que nao expira no meio do turno

Token de 7 dias sem refresh. O atendente e deslogado sem aviso durante o
atendimento. Ver armadilha 14 no HANDOFF.

### 7. Estoque

Evolucao natural do toggle manual "em falta" ja entregue: cadastro de
quantidade, baixa automatica na venda, produto sai do cardapio ao zerar.

---

## Sem data

- Cardapio digital + QR na mesa (recurso que vende o SaaS)
- Supabase Auth (`docs/PHASE-8-AUTH-AUDIT.md`)
- Validar frontend tela por tela com Playwright
- Limpar as 92 empresas de teste do Supabase
- Dominio proprio
- Deferred do KDS: indices Mongo para `kds_tokens`; 404 em `POST /kds/concluir`
  quando a comanda nao existe
