-- ============================================================================
-- Restaurant OS :: Migration 0022 :: Natureza da despesa (fixa/variavel)
-- ============================================================================
-- O relatorio ja tinha `categoria` (texto livre), mas nao sabia distinguir
-- despesa que acontece independente de vender (aluguel, salario) de despesa
-- que so existe porque vendeu (embalagem, comissao de app, combustivel de
-- entrega). Sem essa distincao nao da para calcular ponto de equilibrio — o
-- numero que responde "quanto preciso vender no mes para nao ter prejuizo",
-- que e a pergunta que o dono de restaurante mais precisa responder.
--
-- NULL = nao classificada. Fica de fora do ponto de equilibrio em vez de ser
-- chutada para um dos lados, pela mesma razao que `produtos.custo` distingue
-- NULL de 0 (ver 0020): indicador com premissa inventada e pior que indicador
-- ausente, porque parece confiavel.

alter table public.transacoes
  add column if not exists natureza text default null
    check (natureza is null or natureza in ('fixa', 'variavel'));

-- Relatorio filtra despesa por periodo e agrupa por categoria/natureza. Sem
-- indice isso e varredura completa da tabela que mais cresce no sistema.
create index if not exists idx_transacoes_empresa_tipo_data
  on public.transacoes (empresa_id, tipo, data desc);
