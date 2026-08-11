-- ============================================================================
-- Restaurant OS :: Migration 0003 :: Fase 4 - numeracao atomica de pedidos
-- ----------------------------------------------------------------------------
-- Achado da auditoria (docs/plans/MONGO-TO-SUPABASE-AUDIT.md, secao 18.3):
-- a numeracao de pedidos nunca foi atomica - nem no MongoDB
-- (`countDocuments()+1`), nem na trigger original `pedidos_set_numero()`
-- (`select max(numero)+1`, sujeita a race condition sob concorrencia real:
-- duas transacoes podem ler o mesmo max() antes de qualquer uma commitar).
--
-- Esta migration substitui a implementacao por um contador dedicado por
-- empresa, atualizado via UPSERT atomico (INSERT ... ON CONFLICT DO UPDATE
-- ... RETURNING), que serializa concorrencia por lock de linha - duas
-- transacoes concorrentes NUNCA recebem o mesmo numero para a mesma
-- empresa. A constraint `unique (empresa_id, numero)' ja existente em
-- 0001_init.sql continua como ultima linha de defesa (integridade), nao
-- como o mecanismo de unicidade em si.
--
-- Isto NAO e regra de negocio - e um contador mecanico (equivalente a uma
-- sequence por tenant; Postgres nao tem "sequence por chave" nativo, entao
-- a tabela+upsert e o padrao idiomatico para esse caso). A trigger
-- `trg_pedidos_numero' ja existente (criada em triggers.sql) continua
-- apontando para a funcao `pedidos_set_numero()' - so o CORPO da funcao
-- muda aqui, o trigger nao precisa ser recriado.
-- ============================================================================

create table if not exists public.pedido_contadores (
  empresa_id    uuid primary key references public.empresas(id) on delete cascade,
  ultimo_numero bigint not null default 0
);

-- Backfill: inicializa o contador de cada empresa com o maior numero ja
-- usado (no-op seguro em banco vazio; necessario se esta migration rodar
-- depois de dados ja existirem em `pedidos`).
insert into public.pedido_contadores (empresa_id, ultimo_numero)
select empresa_id, max(numero) from public.pedidos group by empresa_id
on conflict (empresa_id) do update
  set ultimo_numero = greatest(public.pedido_contadores.ultimo_numero, excluded.ultimo_numero);

create or replace function public.pedidos_set_numero()
returns trigger language plpgsql as $$
declare
  novo bigint;
begin
  if new.numero is null then
    insert into public.pedido_contadores (empresa_id, ultimo_numero)
    values (new.empresa_id, 1)
    on conflict (empresa_id) do update
      set ultimo_numero = public.pedido_contadores.ultimo_numero + 1
    returning ultimo_numero into novo;
    new.numero := novo;
  end if;
  return new;
end; $$;
