-- ============================================================================
-- Restaurant OS :: Migration 0006 :: Fase 4 - `pagamentos`
-- ----------------------------------------------------------------------------
-- Fonte relacional unica de pagamentos. NAO reproduz `comanda.pagamentos[]`
-- (achado da auditoria: era um array denormalizado, 100% duplicado desta
-- tabela) - o total pago por comanda continua sendo uma soma calculada
-- pelo Service (equivalente a computeComanda().pago), nunca uma coluna
-- sincronizada por trigger.
-- ============================================================================

create table if not exists public.pagamentos (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references public.empresas(id) on delete cascade,
  comanda_id          uuid references public.comandas(id) on delete set null,
  pedido_id           uuid references public.pedidos(id) on delete set null,
  -- Sem CHECK: `metodo` vem de b.metodo em POST /comandas/:id/pagamentos
  -- sem validacao contra lista fixa no codigo atual - restringir aqui
  -- rejeitaria valores que o Mongo aceita hoje.
  metodo              text not null,
  -- >= 0, nao > 0: POST /comandas/:id/pagamentos so rejeita quando
  -- `valor === undefined`, entao valor=0 e aceito pelo app hoje.
  valor               numeric(12,2) not null check (valor >= 0),
  status              text not null default 'pending'
                        check (status in ('pending','approved','rejected','cancelled','refunded','unknown')),
  provider            text not null check (provider in ('manual','mercadopago')),
  provider_payment_id text,
  external_reference  text,
  idempotency_key     text not null,
  qr_code             text,
  qr_code_base64      text,
  ticket_url          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Todo pagamento deve estar vinculado a algo (hoje sempre comanda_id;
  -- pedido_id existe no dominio para o caso futuro de pagamento direto de
  -- pedido sem comanda - ver domain.ts PagamentoRegistro).
  constraint pagamentos_vinculo_check check (comanda_id is not null or pedido_id is not null),
  -- idempotency_key e sempre gerado via uuidv4() no codigo atual (nunca
  -- colide na pratica); a constraint torna essa garantia explicita no banco.
  unique (idempotency_key)
  -- unique(provider, provider_payment_id) e adicionado abaixo via CREATE
  -- UNIQUE INDEX em vez de constraint inline, para poder comentar o
  -- comportamento com NULLs claramente.
);

-- NULLs nao sao considerados iguais entre si por padrao no Postgres, entao
-- multiplos pagamentos manuais (provider_payment_id sempre null) convivem
-- sem colidir; so bloqueia duplicar o MESMO provider_payment_id real
-- (protege contra o webhook do Mercado Pago processar o mesmo pagamento
-- duas vezes e criar dois registros).
create unique index if not exists idx_pagamentos_provider_payment_id
  on public.pagamentos(provider, provider_payment_id);

create index if not exists idx_pagamentos_empresa on public.pagamentos(empresa_id);
create index if not exists idx_pagamentos_comanda on public.pagamentos(empresa_id, comanda_id);

drop trigger if exists trg_pagamentos_updated on public.pagamentos;
create trigger trg_pagamentos_updated before update on public.pagamentos
  for each row execute function public.set_updated_at();

alter table public.pagamentos enable row level security;
drop policy if exists pagamentos_tenant on public.pagamentos;
create policy pagamentos_tenant on public.pagamentos
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
