-- ============================================================================
-- Restaurant OS :: Migration 0027 :: Assinaturas (mensalidade do SaaS)
-- ============================================================================
-- Ate aqui o sistema nao sabia que e vendido: `empresas.plano` era um texto
-- livre ('free') que ninguem lia. Esta tabela e o contrato comercial entre a
-- ETNA e cada restaurante — quanto custa, quando vence, se esta em dia.
--
-- NAO confundir com `contas` (migration 0025): aquela e o contas a
-- pagar/receber DO RESTAURANTE (fornecedor, aluguel dele). Esta e a
-- mensalidade que o restaurante paga PARA A ETNA. Dominios diferentes, donos
-- diferentes, nunca devem se misturar num relatorio.
--
-- `status` guarda so o que e FATO ('ativa'/'cancelada'). "Atrasada" e
-- "vence em breve" sao DERIVADOS da data na leitura (lib/assinatura.js),
-- mesma regra de `contas.status_efetivo` (0025) e pelo mesmo motivo: status
-- de atraso gravado exigiria um robo virando o registro todo dia, e um unico
-- dia sem esse robo rodar deixaria a carteira inteira mentindo.

create table public.assinaturas (
  id uuid primary key default gen_random_uuid(),
  -- UNIQUE: uma assinatura por empresa. Renovacao atualiza a linha e avanca
  -- `proximo_vencimento`; o historico de pagamentos vive em
  -- `assinatura_pagamentos`, nao em linhas duplicadas aqui.
  empresa_id uuid not null unique references public.empresas(id) on delete cascade,
  plano text not null default 'basico',
  valor numeric(10,2) not null default 0,
  -- Dia do mes acordado com o cliente. 1..31 — quando o mes destino nao tem
  -- o dia (31 em fevereiro), `adicionarMeses()` (lib/contas.js) clampa no
  -- ultimo dia real, nunca rola para o mes seguinte.
  dia_vencimento integer not null default 10,
  proximo_vencimento date not null,
  status text not null default 'ativa',
  ultimo_pagamento_em date,
  observacoes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assinaturas_status_valido check (status in ('ativa', 'cancelada')),
  constraint assinaturas_valor_nao_negativo check (valor >= 0),
  constraint assinaturas_dia_valido check (dia_vencimento between 1 and 31)
);

create index idx_assinaturas_vencimento
  on public.assinaturas (proximo_vencimento) where status = 'ativa';

-- Historico de mensalidades recebidas. Existe separado da assinatura porque
-- a assinatura e o estado ATUAL (quanto, quando vence) e isto e o registro
-- do que ja aconteceu — sobrescrever `ultimo_pagamento_em` a cada mes
-- apagaria a memoria de quem sempre paga atrasado, que e justamente o dado
-- que interessa para decidir bloquear ou nao.
create table public.assinatura_pagamentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  assinatura_id uuid not null references public.assinaturas(id) on delete cascade,
  valor numeric(10,2) not null,
  competencia date not null,
  pago_em date not null,
  metodo text not null default '',
  observacoes text not null default '',
  registrado_por text not null default '',
  created_at timestamptz not null default now(),
  constraint assinatura_pagamentos_valor_positivo check (valor > 0)
);

create index idx_assinatura_pagamentos_empresa
  on public.assinatura_pagamentos (empresa_id, pago_em desc);

-- ============================================================================
-- Administradores da PLATAFORMA (a ETNA), nao de um restaurante.
-- ============================================================================
-- Tabela SEPARADA, e nao uma flag em `usuarios`, de proposito: um usuario
-- pertence sempre a uma empresa (`usuarios.empresa_id NOT NULL`). Marcar o
-- dono da ETNA como "super admin" ali significaria que a conta dele tambem e
-- de algum restaurante — e o vazamento daquela conta entregaria a plataforma
-- inteira. Aqui a identidade e o e-mail, desacoplada de qualquer tenant.
create table public.plataforma_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  nome text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

-- RLS: estas tabelas sao da PLATAFORMA, nao de um tenant. Nenhuma policy
-- concede acesso por `empresa_id` — o acesso passa exclusivamente pela
-- checagem de admin no servidor (route.js), com a service_role. Habilitado
-- mesmo assim para que, no dia em que o app deixar de usar service_role
-- (item C4), o default seja NEGAR em vez de expor tudo.
alter table public.assinaturas enable row level security;
alter table public.assinatura_pagamentos enable row level security;
alter table public.plataforma_admins enable row level security;
