-- ============================================================================
-- Restaurant OS :: Triggers & Functions
-- ============================================================================

-- 1) updated_at automatico
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

do $$
declare t text;
begin
  foreach t in array array['empresas','usuarios','categorias','produtos','clientes','pedidos','integracoes']
  loop
    execute format('drop trigger if exists trg_%1$s_updated on public.%1$s;', t);
    execute format('create trigger trg_%1$s_updated before update on public.%1$s for each row execute function public.set_updated_at();', t);
  end loop;
end $$;

-- 2) numero sequencial de pedido por empresa
create or replace function public.pedidos_set_numero()
returns trigger language plpgsql as $$
begin
  if new.numero is null then
    select coalesce(max(numero),0)+1 into new.numero from public.pedidos where empresa_id = new.empresa_id;
  end if;
  return new;
end; $$;
drop trigger if exists trg_pedidos_numero on public.pedidos;
create trigger trg_pedidos_numero before insert on public.pedidos
  for each row execute function public.pedidos_set_numero();

-- 3) recalculo do total do pedido a partir dos itens
create or replace function public.pedido_recalc_total()
returns trigger language plpgsql as $$
declare pid uuid;
begin
  pid := coalesce(new.pedido_id, old.pedido_id);
  update public.pedidos p set total = coalesce((
    select sum(preco * quantidade) from public.pedido_itens where pedido_id = pid
  ),0) where p.id = pid;
  return null;
end; $$;
drop trigger if exists trg_itens_total on public.pedido_itens;
create trigger trg_itens_total after insert or update or delete on public.pedido_itens
  for each row execute function public.pedido_recalc_total();

-- 4) ao concluir pedido -> gera receita + atualiza metricas do cliente
create or replace function public.pedido_on_conclusao()
returns trigger language plpgsql as $$
begin
  if new.status = 'concluido' and old.status is distinct from 'concluido' then
    insert into public.transacoes(empresa_id, tipo, categoria, descricao, valor, pedido_id, data)
    values (new.empresa_id, 'receita', 'Vendas', 'Pedido #'||new.numero, new.total, new.id, now());
    if new.cliente_id is not null then
      update public.clientes set total_pedidos = total_pedidos + 1, total_gasto = total_gasto + new.total
      where id = new.cliente_id;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists trg_pedido_conclusao on public.pedidos;
create trigger trg_pedido_conclusao after update on public.pedidos
  for each row execute function public.pedido_on_conclusao();
