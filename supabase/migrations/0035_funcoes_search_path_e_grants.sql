-- ============================================================================
-- Restaurant OS :: Migration 0035 :: search_path fixo + grants das funcoes
-- ============================================================================
-- Achados do Security Advisor do Supabase (2026-11-17), complemento da 0034.
--
-- 1) `function_search_path_mutable` (WARN) em 11 funcoes.
--    Sem search_path fixo, a funcao resolve nomes nao qualificados pelo
--    search_path de QUEM CHAMA — um role com permissao de criar objetos num
--    schema que venha antes no path poderia "sombrear" uma tabela/funcao.
--    Todas as 11 ja usam nomes qualificados (`public.x`) ou funcoes nativas
--    (pg_catalog e sempre pesquisado, mesmo com path vazio: gen_random_uuid,
--    now, jsonb_*), entao `search_path = ''` e o valor mais restrito possivel
--    sem mudar comportamento. Validado em transacao com rollback contra
--    producao antes de aplicar (criacao de pedido + comanda + numeracao).
--
-- 2) `anon_security_definer_function_executable` (WARN) em
--    current_empresa_id() e current_papel().
--    Sao SECURITY DEFINER de proposito: as policies *_tenant (20 delas) as
--    usam para descobrir a empresa do usuario logado sem cair em recursao de
--    RLS na tabela `usuarios`. Para `anon` nao fazem sentido (auth.uid() e
--    NULL), entao o EXECUTE sai de anon/PUBLIC.
--    O aviso equivalente para `authenticated` (lint 0029) e ACEITO e
--    INTENCIONAL: revogar quebraria todas as policies de tenant no dia em
--    que a autenticacao migrar para Supabase Auth (decisao ja tomada, ver
--    HANDOFF §9). Nao "corrigir" esse aviso sem rever as policies.
--
-- Idempotente: ALTER FUNCTION ... SET e GRANT/REVOKE podem repetir.

alter function public.set_updated_at()                                   set search_path = '';
alter function public.pedidos_set_numero()                               set search_path = '';
alter function public.next_pedido_numero(uuid)                          set search_path = '';
alter function public.increment_cliente_metricas(uuid, uuid, numeric)    set search_path = '';
alter function public.increment_conversa_nao_lidas(uuid, uuid, text, timestamptz, text) set search_path = '';
alter function public.create_pedido_com_itens(jsonb, jsonb)              set search_path = '';
alter function public.create_comanda_com_itens(jsonb, jsonb)             set search_path = '';
alter function public.upsert_pedido_com_itens(jsonb, jsonb)              set search_path = '';
alter function public.upsert_comanda_com_itens(jsonb, jsonb)             set search_path = '';
alter function public.resync_pedido_contadores()                         set search_path = '';
alter function public.resync_pedido_contador_empresa(uuid)               set search_path = '';

revoke execute on function public.current_empresa_id() from public, anon;
revoke execute on function public.current_papel()      from public, anon;
grant  execute on function public.current_empresa_id() to authenticated, service_role;
grant  execute on function public.current_papel()      to authenticated, service_role;
