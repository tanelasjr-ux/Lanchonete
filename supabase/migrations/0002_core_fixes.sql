-- ============================================================================
-- Restaurant OS :: Migration 0002 :: Fase 4 - correcoes identificadas na
-- auditoria MongoDB -> Supabase (docs/plans/MONGO-TO-SUPABASE-AUDIT.md)
-- ----------------------------------------------------------------------------
-- Somente schema: colunas/constraints ausentes em tabelas ja existentes.
-- Nenhuma regra de negocio, nenhuma trigger nova de negocio.
-- Idempotente (if not exists / drop if exists) para poder rodar mais de
-- uma vez com seguranca.
-- ============================================================================

-- =============================== EMPRESAS ==================================
-- 6 colunas usadas pelo app (route.js: POST /auth/register, PUT /empresa)
-- que existiam no Mongo mas nao no schema Supabase original.
alter table public.empresas
  add column if not exists nome_comercial        text not null default '',
  add column if not exists cnpj                  text not null default '',
  add column if not exists whatsapp              text not null default '',
  add column if not exists email                 text not null default '',
  add column if not exists logo                  text,
  add column if not exists horario_funcionamento text not null default '';

-- =============================== USUARIOS ===================================
-- senha_hash: formato "salt:hash" (scrypt), usado pelo AuthProvider JWT local
-- atual (lib hashPassword/verifyPassword em route.js). NOT NULL porque hoje
-- todo usuario e criado por esse fluxo; quando a Fase 8 (auditoria de Auth)
-- avaliar Supabase Auth, esta constraint pode precisar ser revisada para
-- permitir usuarios sem senha local.
alter table public.usuarios
  add column if not exists senha_hash text;
update public.usuarios set senha_hash = '' where senha_hash is null;
alter table public.usuarios
  alter column senha_hash set not null,
  alter column senha_hash set default '';

-- O schema original assumia `id = auth.users.id` (comentario em 0001_init.sql)
-- e por isso `id` nao tinha default. Enquanto a autenticacao continuar sendo
-- JWT local (decisao explicita: nao alterar Auth nesta fase), o Service
-- gera o id como faz hoje no Mongo (uuidv4()) - dar um default aqui evita
-- quebrar esse fluxo sem impedir que uma migracao futura de Auth insira
-- explicitamente `id = auth.users.id` quando for o caso (um default so se
-- aplica quando a coluna nao e informada no INSERT).
alter table public.usuarios
  alter column id set default gen_random_uuid();

-- =============================== TRANSACOES =================================
-- comanda_id: preenchido quando a transacao nasce do fechamento de uma
-- comanda (POST /comandas/:id/fechar). FK adicionada na migration 0005,
-- depois que a tabela `comandas` existir (ordem de dependencia).
alter table public.transacoes
  add column if not exists comanda_id uuid;

-- =============================== INTEGRACOES ================================
-- CHECK original nao incluia 'mercadopago', que ja e seedado pela aplicacao
-- (seedEmpresa() em route.js) desde o modulo de pagamentos (v2).
alter table public.integracoes
  drop constraint if exists integracoes_tipo_check;
alter table public.integracoes
  add constraint integracoes_tipo_check check (tipo in ('evolution','n8n','mercadopago'));

-- status so assume 2 valores na pratica (route.js so escreve
-- 'nao_configurado'/'configurado'); constraint nao existia, adicionada por
-- integridade (nao e regra de negocio, so restringe o dominio de valores).
alter table public.integracoes
  drop constraint if exists integracoes_status_check;
alter table public.integracoes
  add constraint integracoes_status_check check (status in ('nao_configurado','configurado'));

-- =============================== PEDIDOS ====================================
-- Dois achados desta auditoria (nao cobertos no MONGO-TO-SUPABASE-AUDIT.md
-- original, encontrados ao cruzar route.js com o schema durante a Fase 4):
--
-- 1) `status` real aceita DOIS vocabularios sem normalizacao (ver
--    normPedidoStatus() em route.js e PedidoStatus em domain.ts): o
--    minusculo original e o maiusculo do fluxo de atendimento/delivery v3.
--    O CHECK original so permitia o primeiro - um pedido criado via
--    Central de Atendimento com status='ENTREGUE' violaria a constraint.
alter table public.pedidos
  drop constraint if exists pedidos_status_check;
alter table public.pedidos
  add constraint pedidos_status_check check (status in (
    'recebido','em_preparo','pronto','concluido','cancelado',
    'NOVO','CONFIRMADO','EM_PREPARACAO','PRONTO','SAIU_PARA_ENTREGA','ENTREGUE','CANCELADO'
  ));

-- 2) `pagamento` e preenchido em POST /comandas/:id/fechar com
--    `comanda.pagamentos[0].metodo`, que vem de b.metodo em
--    POST /comandas/:id/pagamentos SEM validacao contra uma lista fixa -
--    na pratica os 4 metodos configuraveis por empresa sao
--    dinheiro/pix/cartao_debito/cartao_credito (ver PAYMENT_METHODS em
--    lib/integrations/payments/provider.js), nao os 3 do CHECK original.
--    Ampliado para o conjunto realista; `pagamentos.metodo` (tabela nova,
--    migration 0006) fica deliberadamente sem CHECK porque o campo de
--    origem (b.metodo) e livre no codigo atual - nao restringir mais do
--    que o Mongo restringe hoje.
alter table public.pedidos
  drop constraint if exists pedidos_pagamento_check;
alter table public.pedidos
  add constraint pedidos_pagamento_check check (pagamento in (
    'pix','cartao','dinheiro','cartao_debito','cartao_credito'
  ));

-- =============================== PEDIDO_ITENS ===============================
-- Decisao do dono do projeto (migracao Mongo->Supabase, 2026-08-09): itens
-- de pedido/comanda sao snapshot historico completo, preco nunca
-- recalculado a partir do produto atual. O Mongo real hoje SO grava
-- {produto_id, nome, preco, quantidade} - id/desconto/observacao/subtotal
-- sao sinteticos na migracao de dados (Fase 6), nao existem na origem.
alter table public.pedido_itens
  add column if not exists desconto   numeric(12,2) not null default 0 check (desconto >= 0),
  add column if not exists observacao text not null default '',
  add column if not exists subtotal   numeric(12,2) not null default 0,
  add column if not exists created_at timestamptz not null default now();
