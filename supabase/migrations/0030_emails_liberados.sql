-- ============================================================================
-- Restaurant OS :: Migration 0030 :: Emails liberados (controle de acesso ao cadastro)
-- ============================================================================
-- Ate aqui POST /auth/register era aberto: qualquer pessoa completava o
-- formulario e criava uma empresa nova, sem nenhuma aprovacao do dono.
-- Pedido explicito do dono (2026-08-19): "eu como dono devo ter a
-- possibilidade de adicionar os e-mails que podem ter acesso ao sistema".
--
-- Mesmo espirito de `plataforma_admins` (migration 0027): infraestrutura da
-- PLATAFORMA (a ETNA), nao de um tenant — sem coluna empresa_id (a empresa
-- ainda nem existe quando este registro e consultado), sem RLS policy,
-- acesso so via service_role + checagem em route.js
-- (`superpowers/skills/... exigePlataformaAdmin()`).
--
-- `usado_em` comeca NULL e e preenchido no momento em que POST /auth/register
-- daquele e-mail e aceito — da pro Painel ETNA mostrar "aguardando cadastro"
-- vs "empresa ja criada em DD/MM" sem precisar cruzar com `usuarios`.
create table public.emails_liberados (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  nome text not null default '',
  liberado_por text not null default '',
  usado_em timestamptz,
  created_at timestamptz not null default now()
);

alter table public.emails_liberados enable row level security;
