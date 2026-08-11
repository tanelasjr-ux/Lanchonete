-- ============================================================================
-- Restaurant OS :: Migration 0008 :: Fase 4 - `conversas` + `mensagens`
-- ----------------------------------------------------------------------------
-- Central de Atendimento WhatsApp (v3). Campos conferidos contra o webhook
-- pre-auth em route.js e packages/domain/src/index.ts (Conversa, Mensagem).
-- ============================================================================

create table if not exists public.conversas (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references public.empresas(id) on delete cascade,
  cliente_id         uuid references public.clientes(id) on delete set null,
  contato_nome       text not null default '',
  contato_numero     text not null,
  status             text not null default 'ABERTA'
                       check (status in ('ABERTA','AGUARDANDO_EQUIPE','AGUARDANDO_CLIENTE','RESOLVIDA')),
  ultima_mensagem    text not null default '',
  ultima_mensagem_em timestamptz not null default now(),
  nao_lidas          int not null default 0 check (nao_lidas >= 0),
  operador_id        uuid references public.usuarios(id) on delete set null,
  -- Referencia solta no codigo atual (nao valida que o pedido existe antes
  -- de salvar). FK com on delete set null preserva o comportamento
  -- permissivo sem deixar referencia orfa.
  pedido_ativo_id    uuid references public.pedidos(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- O webhook faz find-or-create por (empresa_id, contato_numero) - nunca
  -- deveria haver duas conversas abertas pro mesmo numero na mesma empresa.
  unique (empresa_id, contato_numero)
);
create index if not exists idx_conversas_empresa on public.conversas(empresa_id);
create index if not exists idx_conversas_empresa_ultima_mensagem on public.conversas(empresa_id, ultima_mensagem_em desc);

create table if not exists public.mensagens (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references public.empresas(id) on delete cascade,
  conversa_id         uuid not null references public.conversas(id) on delete cascade,
  direcao             text not null check (direcao in ('in','out')),
  -- Sem CHECK: `tipo' vem do messageType bruto da Evolution API
  -- (data.messageType), que pode assumir qualquer valor futuro da API
  -- deles alem dos 5 hoje observados (text/image/audio/document/
  -- conversation - 'conversation' NAO e bug, e o messageType real da
  -- Evolution para texto simples).
  tipo                text not null,
  texto               text not null default '',
  media_url           text,
  from_me             boolean not null default false,
  status              text not null default 'delivered',
  -- Identificador externo da Evolution API (key.id no payload do webhook),
  -- usado para rastreamento/futura idempotencia. Sem UNIQUE: a Evolution
  -- API nao garante presenca nem unicidade (codigo atual aceita null).
  provider_message_id text,
  operador_id         uuid references public.usuarios(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists idx_mensagens_conversa on public.mensagens(empresa_id, conversa_id, created_at);

-- Sem trigger de updated_at em mensagens: sao imutaveis (so create + list,
-- ver MensagemRepository em packages/domain/src/index.ts), nunca tem update.
drop trigger if exists trg_conversas_updated on public.conversas;
create trigger trg_conversas_updated before update on public.conversas
  for each row execute function public.set_updated_at();

alter table public.conversas enable row level security;
drop policy if exists conversas_tenant on public.conversas;
create policy conversas_tenant on public.conversas
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());

alter table public.mensagens enable row level security;
drop policy if exists mensagens_tenant on public.mensagens;
create policy mensagens_tenant on public.mensagens
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
