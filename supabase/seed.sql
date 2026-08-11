-- ============================================================================
-- Restaurant OS :: Seeds (catalogo RBAC global)
-- Dados de demonstracao por empresa sao criados pela aplicacao no cadastro.
-- ============================================================================

insert into public.papeis (codigo, label, level) values
  ('OWNER','Proprietario',100),
  ('ADMIN','Administrador',80),
  ('GERENTE','Gerente',60),
  ('ATENDENTE','Atendente',40),
  ('COZINHA','Cozinha',20)
on conflict (codigo) do nothing;

insert into public.permissoes (papel_codigo, modulo) values
  ('ADMIN','dashboard'),('ADMIN','cardapio'),('ADMIN','clientes'),('ADMIN','pedidos'),
  ('ADMIN','financeiro'),('ADMIN','usuarios'),('ADMIN','empresa'),('ADMIN','auditoria'),('ADMIN','integracoes'),
  ('GERENTE','dashboard'),('GERENTE','cardapio'),('GERENTE','clientes'),('GERENTE','pedidos'),('GERENTE','financeiro'),
  ('ATENDENTE','dashboard'),('ATENDENTE','clientes'),('ATENDENTE','pedidos'),
  ('COZINHA','dashboard'),('COZINHA','pedidos')
on conflict do nothing;

-- Fase 4 (auditoria Mongo->Supabase): este catalogo estava desatualizado em
-- relacao a PERMISSIONS em route.js - faltavam os modulos dos ciclos v2/v3
-- (mesas, comandas/pagamentos, relatorios, atendimento). OWNER continua sem
-- linhas aqui de proposito: no codigo (`PERMISSIONS.OWNER = ['*']`) tem
-- acesso irrestrito por convencao, nao enumerado. Este catalogo nao e lido
-- pelo app hoje (RBAC e 100% hardcoded em route.js) - mantido em paridade
-- para quando/se essa decisao mudar, nao usado por nenhuma rota agora.
insert into public.permissoes (papel_codigo, modulo) values
  ('ADMIN','mesas'),('ADMIN','relatorios'),('ADMIN','atendimento'),('ADMIN','pagamentos'),
  ('GERENTE','mesas'),('GERENTE','relatorios'),('GERENTE','atendimento'),('GERENTE','pagamentos'),
  ('ATENDENTE','mesas'),('ATENDENTE','atendimento'),('ATENDENTE','pagamentos')
on conflict do nothing;
