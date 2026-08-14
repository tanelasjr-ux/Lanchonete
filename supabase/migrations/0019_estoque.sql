-- ============================================================================
-- Restaurant OS :: Migration 0019 :: Estoque (inventory management)
-- ============================================================================
-- Tres colunas na tabela produtos para gerenciamento de estoque:
-- - estoque_habilitado: ativa/desativa controle de estoque para o produto
-- - estoque_quantidade: quantidade em estoque (NUMERIC 12,2 para precisao)
-- - estoque_minimo: quantidade minima para alertas (NUMERIC 12,2)

alter table public.produtos
  add column if not exists estoque_habilitado boolean not null default false,
  add column if not exists estoque_quantidade numeric(12,2) default null,
  add column if not exists estoque_minimo numeric(12,2) not null default 0;

-- Index parcial para queries rapidas de produtos com estoque habilitado
-- Filtro: WHERE estoque_habilitado = true reduz significativamente o tamanho
-- Multi-tenant: empresa_id + estoque_habilitado para isolation e performance
create index if not exists idx_produtos_estoque_habilitado
  on public.produtos(empresa_id, estoque_habilitado) where estoque_habilitado = true;
