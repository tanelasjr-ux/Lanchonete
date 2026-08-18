-- ============================================================================
-- Restaurant OS :: Migration 0026 :: Recorrencia em contas a pagar/receber
-- ============================================================================
-- Pedido do dono: poder informar quantas vezes uma despesa/receita vai se
-- repetir (aluguel, financiamento, assinatura) em vez de cadastrar parcela
-- por parcela na mao.
--
-- DECISAO: nao e um "motor de recorrencia" que gera parcela nova sozinho a
-- cada mes. E geracao em lote no momento do cadastro — todas as parcelas
-- nascem como registros `contas` independentes, ligados so pelo `serie_id`
-- pra a tela conseguir agrupar/rotular ("3 de 12"). Cada parcela e paga,
-- cancelada ou editada isoladamente, exatamente como uma conta avulsa —
-- nao ha efeito cascata entre elas. Escopo deliberadamente menor que um
-- motor de recorrencia de verdade, porque o pedido foi "informar quantas
-- vezes", nao "criar regra recorrente".

alter table public.contas
  add column if not exists serie_id uuid,
  add column if not exists serie_indice integer,
  add column if not exists serie_total integer;

-- Usado pela tela pra listar/agrupar as parcelas de uma mesma serie.
create index if not exists idx_contas_serie
  on public.contas (empresa_id, serie_id)
  where serie_id is not null;
