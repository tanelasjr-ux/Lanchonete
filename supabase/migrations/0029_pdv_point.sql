-- ============================================================================
-- Restaurant OS :: Migration 0029 :: PDV — cobranca no cartao pela maquininha
-- ============================================================================
-- Momento em que o pedido foi pago por uma cobranca RASTREADA (Mercado Pago
-- Point). NULL = nao pago por esse caminho — cobre todo o historico anterior
-- e todo pagamento manual (dinheiro, cartao digitado no caixa).
--
-- Existe para resolver um problema concreto: `PUT /pedidos/:id` ja lanca
-- receita ao concluir um pedido. Se o cartao ja pagou (via Point) ANTES de o
-- pedido ser concluido, concluir sem checar este campo lancaria a receita
-- DUAS VEZES — dobrando o faturamento do dia. `pago_em IS NOT NULL` e o guarda
-- que impede isso (route.js, PUT /pedidos/:id).
--
-- `terminal_id` da maquininha NAO ganha coluna nova: vive dentro de
-- `integracoes.config` (jsonb) da integracao 'mercadopago' que ja existe,
-- junto do accessToken — mesma conta, mesma credencial.
alter table public.pedidos
  add column if not exists pago_em timestamptz;
