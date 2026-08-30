-- ============================================================================
-- Restaurant OS :: Migration 0033 :: Taxa de servico padrao vira 0%
-- ============================================================================
-- Pedido do dono, 2026-08-30: comanda nova nao deveria nascer cobrando 10%
-- de taxa de servico por padrao. O codigo (route.js — abrir mesa e o config
-- seedado no signup) ja mudou o default para 0, mas isso so afeta empresa
-- CRIADA a partir de agora. Esta migration corrige o dado ja gravado em
-- `empresas.config.pagamentos.taxa_servico_padrao` para quem ja existe —
-- nunca existiu tela pra configurar esse campo, entao toda empresa hoje tem
-- 10% (ou o campo ausente) so porque era o valor de codigo antigo, nunca
-- uma escolha deliberada.
--
-- So corrige quem ainda esta no valor antigo (10) ou sem o campo — nunca
-- sobrescreve um valor diferente, caso algum dia alguem tenha editado via
-- API direto.
update public.empresas
set config = jsonb_set(
  coalesce(config, '{}'::jsonb),
  '{pagamentos,taxa_servico_padrao}',
  '0'::jsonb
)
where coalesce((config #>> '{pagamentos,taxa_servico_padrao}')::numeric, 10) = 10;
