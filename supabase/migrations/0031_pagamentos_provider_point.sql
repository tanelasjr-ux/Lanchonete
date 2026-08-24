-- ============================================================================
-- Restaurant OS :: Migration 0031 :: pagamentos.provider aceita mercadopago_point
-- ============================================================================
-- Bug real de producao encontrado na revisao da Task 10 do plano do PDV: a
-- migration 0006 so previa 'manual' e 'mercadopago' (Pix). As Tasks 6-8 (ja
-- mergeadas) criam pagamentos com provider = 'mercadopago_point' (cobranca
-- pela maquininha) — todo INSERT desses ja estava violando este CHECK em
-- producao (Supabase), so nao foi percebido porque a verificacao manual das
-- Tasks 6-8 rodou contra o Mongo local (sem constraint equivalente), nunca
-- contra o Postgres real.
alter table public.pagamentos drop constraint pagamentos_provider_check;
alter table public.pagamentos add constraint pagamentos_provider_check
  check (provider in ('manual', 'mercadopago', 'mercadopago_point'));
