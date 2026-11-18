-- ============================================================================
-- Restaurant OS :: Migration 0034 :: Fecha 4 tabelas expostas a chave anon
-- ============================================================================
-- Achado do Security Advisor do Supabase (2026-11-17, lint
-- `rls_disabled_in_public`, nivel ERROR): estas tabelas estavam no schema
-- `public` (exposto pelo PostgREST) com RLS DESLIGADO e com GRANT total
-- (SELECT/INSERT/UPDATE/DELETE/TRUNCATE) para `anon` e `authenticated`.
--
-- A chave `anon` e publica por definicao (vai no bundle do navegador como
-- NEXT_PUBLIC_SUPABASE_ANON_KEY). Ou seja: qualquer visitante do site podia,
-- via `/rest/v1/<tabela>`:
--   - papeis / permissoes  -> reescrever o modelo de autorizacao (RBAC)
--   - pedido_contadores    -> baguncar a numeracao sequencial de pedidos
--   - schema_migrations    -> apagar o controle do migrator e forcar
--                             reexecucao de migrations no proximo boot
--
-- Por que isto nao quebra a aplicacao: o backend acessa o banco SEMPRE com a
-- service_role (que ignora RLS) ou, no migrator, com o role dono das tabelas.
-- As funcoes SECURITY DEFINER que leem papeis/permissoes (current_papel etc.)
-- rodam como o dono e tambem nao sao afetadas. O navegador nao consulta o
-- Supabase direto (a anon key so e usada para checar se esta configurado).
--
-- Mesmo padrao de `plataforma_admins` (0027) e `emails_liberados` (0030):
-- RLS ligado sem policy = fechado para anon/authenticated, aberto so para
-- service_role. O REVOKE e defesa em profundidade, caso alguem crie uma
-- policy permissiva por engano no futuro.
--
-- Idempotente: ENABLE RLS e REVOKE podem rodar mais de uma vez sem erro.

alter table public.papeis            enable row level security;
alter table public.permissoes        enable row level security;
alter table public.pedido_contadores enable row level security;
alter table public.schema_migrations enable row level security;

revoke all on table public.papeis            from anon, authenticated;
revoke all on table public.permissoes        from anon, authenticated;
revoke all on table public.pedido_contadores from anon, authenticated;
revoke all on table public.schema_migrations from anon, authenticated;
