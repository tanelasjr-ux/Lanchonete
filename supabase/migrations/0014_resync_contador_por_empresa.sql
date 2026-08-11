-- ============================================================================
-- Restaurant OS :: Migration 0014 :: resync do contador de pedidos por empresa
-- ----------------------------------------------------------------------------
-- Achado na Fase 7, rodando a suite de regressao real contra o Supabase:
-- o seed de demonstracao (`seedEmpresa()` em route.js) insere pedidos em lote
-- com `numero` explicito (1..N), mas o bulk insert nao passa pela trigger de
-- numeracao e portanto nao avanca `pedido_contadores`. O primeiro pedido
-- criado depois do seed pedia `next_pedido_numero()`, recebia 1 e colidia com
-- o pedido #1 do seed:
--   duplicate key value violates unique constraint "pedidos_empresa_id_numero_key"
--
-- No MongoDB o problema nao existia porque `nextNumero()` la e `count()+1`,
-- que ja enxerga os pedidos do seed. E a mesma classe de risco que a
-- ferramenta de migracao ja tratava chamando `resync_pedido_contadores()`
-- (migration 0011) — que porem varre TODAS as empresas. Para o seed, chamado
-- a cada novo cadastro, um resync global seria caro sem necessidade.
--
-- Esta funcao faz o mesmo, escopado a uma empresa. Continua MECANICA (nao
-- decide valor de negocio: apenas alinha o contador ao maior numero que ja
-- existe na tabela).
-- ============================================================================

create or replace function public.resync_pedido_contador_empresa(p_empresa_id uuid)
returns bigint language plpgsql as $$
declare
  v_max bigint;
begin
  select coalesce(max(numero), 0) into v_max
  from public.pedidos where empresa_id = p_empresa_id;

  insert into public.pedido_contadores (empresa_id, ultimo_numero)
  values (p_empresa_id, v_max)
  on conflict (empresa_id) do update
    set ultimo_numero = greatest(public.pedido_contadores.ultimo_numero, excluded.ultimo_numero);

  return v_max;
end;
$$;
