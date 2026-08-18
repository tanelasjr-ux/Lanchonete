-- ============================================================================
-- Restaurant OS :: Migration 0025 :: Contas a pagar/receber
-- ============================================================================
-- Ate aqui o financeiro so registrava o que JA aconteceu (`transacoes` — a
-- camada de CAIXA). Esta tabela e a camada de OBRIGACAO: o que ainda vai
-- vencer. As duas sao deliberadamente separadas — uma conta a pagar nao entra
-- em nenhum numero do DRE/relatorio ate ser marcada como paga, porque contar
-- como despesa um boleto que ainda nao saiu do bolso inflaria o resultado com
-- dinheiro que nao mudou de mao.
--
-- Marcar como paga CRIA a transacao correspondente (route.js) — e o unico
-- jeito de uma conta virar numero de relatorio. `transacao_id` guarda o elo.

create table public.contas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  tipo text not null,
  descricao text not null default '',
  categoria text not null default 'Outros',
  -- Mesma regra de natureza das transacoes (migration 0022): so faz sentido
  -- para 'pagar' (entra no ponto de equilibrio depois de paga), nunca
  -- inferida — quem lanca decide, o servidor nao adivinha.
  natureza text,
  valor numeric(10,2) not null,
  -- DATE, nao TIMESTAMPTZ: vencimento e um dia, nao um instante. Comparar
  -- "venceu ou nao" com hora embutida criaria fuso horario como fonte de bug.
  vencimento date not null,
  status text not null default 'pendente',
  pago_em timestamptz,
  transacao_id uuid references public.transacoes(id) on delete set null,
  observacoes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contas_tipo_valido check (tipo in ('pagar', 'receber')),
  constraint contas_natureza_valida check (natureza is null or natureza in ('fixa', 'variavel')),
  constraint contas_valor_positivo check (valor > 0),
  -- 'atrasada' NUNCA e um status gravado — e sempre derivado de
  -- `vencimento < hoje AND status = 'pendente'` na leitura (lib/contas.js).
  -- Guardar como coluna exigiria um job diario para virar o status sozinho;
  -- um dia sem esse job rodar deixaria a lista inteira mentindo.
  constraint contas_status_valido check (status in ('pendente', 'paga', 'cancelada'))
);

-- A tela de listagem filtra por tipo/status e ordena por vencimento — e a
-- consulta mais frequente desta tabela.
create index idx_contas_empresa_status_vencimento
  on public.contas (empresa_id, status, vencimento);

alter table public.contas enable row level security;
create policy contas_por_empresa on public.contas
  for all using (empresa_id = (select empresa_id from public.usuarios where id = auth.uid()));
