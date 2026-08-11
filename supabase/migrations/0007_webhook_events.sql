-- ============================================================================
-- Restaurant OS :: Migration 0007 :: Fase 4 - `webhook_events`
-- ----------------------------------------------------------------------------
-- No Mongo hoje so existe {eventKey, empresa_id, provider, received_at} e
-- SEM constraint de unicidade real sobre eventKey (dedupe depende so de
-- upsert em codigo - achado da auditoria). Aqui a unicidade e uma
-- constraint de verdade, e o schema fica mais rico do que o uso atual
-- (payload/status/processed_at) por pedido explicito desta fase, para
-- suportar idempotencia/observabilidade quando os webhooks de
-- Evolution/Mercado Pago forem escritos via SupabaseIntegracaoRepository
-- (Fase 5/6) - nao muda nada hoje, MongoDB continua sendo quem grava
-- webhook_events em producao.
-- ============================================================================

create table if not exists public.webhook_events (
  id           uuid primary key default gen_random_uuid(),
  -- Formato atual: "${empresaId}:${dataId}:${requestId}" (ver route.js,
  -- webhook do Mercado Pago). Preservado como esta.
  event_key    text not null,
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  provider     text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'received'
                 check (status in ('received','processed','ignored','error')),
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (event_key)
);
create index if not exists idx_webhook_events_empresa on public.webhook_events(empresa_id);

-- Nao e uma entidade de dominio (nao aparece em domain.ts, nao tem tela),
-- mas ganha RLS por consistencia/defesa em profundidade, mesmo padrao das
-- tabelas de dominio.
alter table public.webhook_events enable row level security;
drop policy if exists webhook_events_tenant on public.webhook_events;
create policy webhook_events_tenant on public.webhook_events
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
