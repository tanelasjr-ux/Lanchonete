-- ============================================================================
-- Restaurant OS :: Migration 0024 :: Tipos de pedido enxugados
-- ============================================================================
-- O sistema oferecia quatro tipos: balcao, retirada, delivery e mesa. Na
-- operacao real do dono, "balcao" e "retirada" descrevem a MESMA coisa — o
-- cliente veio ate o restaurante e vai levar o pedido embora. A distincao so
-- gerava duvida na hora de lancar e dividia o mesmo faturamento em duas linhas
-- no relatorio por canal, sem que ninguem soubesse dizer o criterio.
--
-- Passam a existir tres, que e como o dono descreve o negocio:
--   delivery   -> sai para entrega
--   mesa       -> consome no local (nasce do fechamento de uma comanda)
--   para_levar -> veio buscar (absorve balcao + retirada)
--
-- Direcao deliberada: NADA e apagado. Os pedidos historicos de balcao e
-- retirada sao reclassificados para `para_levar`, entao continuam contando no
-- faturamento, no CMV e na margem por canal — o que muda e o rotulo sob o qual
-- aparecem. Perder venda antiga de vista para "limpar" o vocabulario seria
-- pior que a duvida que estamos corrigindo.
--
-- IRREVERSIVEL na pratica: depois desta migration nao ha como saber quais
-- `para_levar` eram balcao e quais eram retirada. Foi decisao explicita do
-- dono em 2026-08-18 ("nao ha necessidade de tantos tipos"), justamente
-- porque a distincao nunca teve uso.

-- 1) Abre o CHECK para aceitar o valor novo ANTES de reclassificar. Na ordem
--    inversa, o UPDATE violaria a restricao ainda vigente e a migration
--    morreria no meio.
alter table public.pedidos drop constraint if exists pedidos_tipo_check;
alter table public.pedidos add constraint pedidos_tipo_check
  check (tipo = any (array['balcao','retirada','delivery','mesa','para_levar']));

-- 2) Reclassifica o historico.
update public.pedidos
set tipo = 'para_levar'
where tipo in ('balcao', 'retirada');

-- 3) Fecha o CHECK no vocabulario final. Rodar isto depois do UPDATE garante
--    que nenhuma linha antiga ficou para tras — se alguma tivesse ficado, a
--    restricao falharia aqui e derrubaria o boot, que e o comportamento certo
--    (schema errado em silencio causa mais dano que deploy que falha alto).
alter table public.pedidos drop constraint pedidos_tipo_check;
alter table public.pedidos add constraint pedidos_tipo_check
  check (tipo = any (array['delivery','mesa','para_levar']));

-- O default da coluna tambem apontava para o vocabulario antigo.
alter table public.pedidos alter column tipo set default 'para_levar';
