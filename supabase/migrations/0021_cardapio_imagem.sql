-- ============================================================================
-- Restaurant OS :: Migration 0021 :: Cardapio Digital — imagem
-- ============================================================================
-- Restaurante sobe uma imagem (poster/foto do cardapio impresso) para servir
-- no link/QR publico que ja existe. Espelha exatamente `logo` (mesma coluna
-- de topo, mesmo padrao de upload em lib/integrations/storage.js) em vez de
-- entrar em `config` jsonb — e um asset enviado por arquivo, nao preferencia.

alter table public.empresas
  add column if not exists cardapio_imagem_url text default null;
