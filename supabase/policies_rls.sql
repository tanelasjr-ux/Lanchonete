-- ============================================================================
-- Restaurant OS :: Row Level Security (RLS)
-- Isolamento total por empresa_id usando o vinculo do usuario autenticado.
-- ============================================================================

-- Retorna o empresa_id do usuario autenticado (via Supabase Auth: auth.uid()).
create or replace function public.current_empresa_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select empresa_id from public.usuarios where id = auth.uid();
$$;

-- Retorna o papel do usuario autenticado.
create or replace function public.current_papel()
returns text
language sql stable security definer set search_path = public
as $$
  select papel from public.usuarios where id = auth.uid();
$$;

-- Habilita RLS em todas as tabelas de dominio.
alter table public.empresas      enable row level security;
alter table public.usuarios      enable row level security;
alter table public.categorias    enable row level security;
alter table public.produtos      enable row level security;
alter table public.clientes      enable row level security;
alter table public.pedidos       enable row level security;
alter table public.pedido_itens  enable row level security;
alter table public.transacoes    enable row level security;
alter table public.integracoes   enable row level security;
alter table public.auditoria     enable row level security;

-- Empresa: usuario ve/edita apenas a propria empresa.
create policy empresa_self on public.empresas
  for all using (id = public.current_empresa_id())
  with check (id = public.current_empresa_id());

-- Usuarios: escopo por tenant; gestao restrita a OWNER/ADMIN.
create policy usuarios_select on public.usuarios
  for select using (empresa_id = public.current_empresa_id());
create policy usuarios_write on public.usuarios
  for all using (empresa_id = public.current_empresa_id() and public.current_papel() in ('OWNER','ADMIN'))
  with check (empresa_id = public.current_empresa_id() and public.current_papel() in ('OWNER','ADMIN'));

-- Macro helper: policy padrao "tenant" para tabelas de dominio.
do $$
declare t text;
begin
  foreach t in array array['categorias','produtos','clientes','pedidos','pedido_itens','transacoes','integracoes','auditoria']
  loop
    execute format($f$
      create policy %1$s_tenant on public.%1$s
        for all using (empresa_id = public.current_empresa_id())
        with check (empresa_id = public.current_empresa_id());
    $f$, t);
  end loop;
end $$;
