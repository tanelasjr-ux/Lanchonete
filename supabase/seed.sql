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
