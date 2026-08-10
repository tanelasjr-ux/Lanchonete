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
-- Mecanico (equivalente a uma sequence por tenant), nao decide nada de
-- negocio - so atribui um inteiro crescente. Nao atomico sob concorrencia
-- (mesma limitacao ja presente no runtime Mongo, ver
-- docs/plans/MONGO-TO-SUPABASE-AUDIT.md secao 18.3); a colisao rara sob
-- concorrencia real e pega pela constraint `unique (empresa_id, numero)'
-- ja existente em 0001_init.sql, que e a forma correta (constraint, nao
-- trigger de negocio) de proteger contra duplicidade aqui.
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

-- ============================================================================
-- REMOVIDO (Fase 3.5 da migracao MongoDB -> Supabase, 2026-08-10):
--   pedido_recalc_total()  - recalculava pedidos.total a partir de
--                            pedido_itens (calculo de total = regra de
--                            negocio).
--   pedido_on_conclusao()  - gerava transacao de receita e atualizava
--                            metricas do cliente ao concluir um pedido
--                            (geracao de receita + transicao de status =
--                            regra de negocio). So cobria status
--                            'concluido', nunca tratou 'ENTREGUE' (usado
--                            pelo fluxo de atendimento/delivery do v3) -
--                            um pedido de delivery concluido via
--                            'ENTREGUE' NUNCA teria gerado receita por
--                            este trigger, mesmo antes desta remocao.
--
-- Essas duas triggers foram escritas antes da decisao explicita do dono
-- do projeto de que regra de negocio (calculo de totais, transicoes de
-- status, geracao de receita) fica exclusivamente no Service, nunca em
-- trigger do Postgres - Postgres fica com integridade e automacoes
-- mecanicas (RLS, FKs, UNIQUE, CHECK, NOT NULL, indices, updated_at,
-- sequencias). Ver docs/ARCHITECTURE.md e
-- docs/plans/MONGO-TO-SUPABASE-AUDIT.md (secao 4) para o achado completo,
-- e docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md para o registro desta limpeza.
--
-- Nenhuma trigger nova substitui estas. Quando a Fase 5/6 implementar
-- SupabasePedidoRepository, o Service (hoje inline em route.js) e quem
-- deve calcular `pedidos.total` (soma de preco*quantidade dos itens,
-- identico ao que MongoPedidoRepository ja recebe pronto do chamador
-- hoje) e disparar a criacao da transacao de receita ao status mudar
-- para 'concluido' OU 'ENTREGUE' (ambos, ao contrario do trigger antigo).
-- Ate a Fase 5/6, isso nao tem efeito nenhum: o runtime continua 100%
-- MongoDB, onde essa regra ja vive corretamente em route.js.
--
-- drop statements idempotentes, para o caso deste arquivo ja ter rodado
-- contra algum banco antes desta correcao:
drop trigger if exists trg_itens_total on public.pedido_itens;
drop function if exists public.pedido_recalc_total();
drop trigger if exists trg_pedido_conclusao on public.pedidos;
drop function if exists public.pedido_on_conclusao();
