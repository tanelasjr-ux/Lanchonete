-- ============================================================================
-- Restaurant OS :: Migration 0032 :: Planos Basico e Completo
-- ============================================================================
-- `assinaturas.plano` existe desde a migration 0027 mas sempre foi texto
-- livre, nunca lido por nenhuma logica de gate (mesmo padrao do bug que
-- motivou a feature de modulos, B1). Esta migration trava o campo num enum
-- de 2 valores e, na MESMA transacao, garante que a unica empresa real em
-- producao (Tanelas FooD) nao perca acesso a Estoque/Caixa, que ja usa
-- ativamente hoje — mesma disciplina da migration 0023 (nunca tirar acesso
-- de quem ja usa).

alter table public.assinaturas
  add constraint assinaturas_plano_valido check (plano in ('basico', 'completo'));

-- Se ja existe assinatura pra Tanelas FooD (pode ter sido configurada
-- manualmente pelo Painel ETNA antes deste plano formal existir — como
-- de fato aconteceu, 2026-08-24), so ATUALIZA o plano pra completo,
-- preservando valor/dia_vencimento/proximo_vencimento/status reais.
-- Nunca tirar acesso de quem ja usa Estoque/Caixa (Global Constraint).
update public.assinaturas a
set plano = 'completo', updated_at = now()
from public.empresas e
where a.empresa_id = e.id and e.nome = 'Tanelas FooD' and a.plano <> 'completo';

-- So cria uma assinatura nova (valores provisorios) se a empresa
-- genuinamente nao tiver nenhuma linha em assinaturas ainda.
insert into public.assinaturas (id, empresa_id, plano, valor, dia_vencimento, proximo_vencimento, status, observacoes)
select gen_random_uuid(), e.id, 'completo', 0, 10, (current_date + interval '30 days')::date, 'ativa',
       'Migrada automaticamente para completo na migration 0032 — ja usava Estoque/Caixa antes de existir plano formal.'
from public.empresas e
where e.nome = 'Tanelas FooD'
  and not exists (select 1 from public.assinaturas a where a.empresa_id = e.id);

-- Espelha o plano em empresas.config (mesmo campo que temModulo() vai ler)
-- para a Tanelas FooD especificamente, ja que o codigo que sincroniza isso
-- automaticamente (Task 4) so entra em vigor a partir do proximo deploy.
update public.empresas
set config = jsonb_set(coalesce(config, '{}'::jsonb), '{plano}', '"completo"'::jsonb)
where nome = 'Tanelas FooD';
