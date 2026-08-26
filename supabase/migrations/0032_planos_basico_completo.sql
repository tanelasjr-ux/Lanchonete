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
--
-- Achado real na revisao final do plano: as tres operacoes abaixo casavam
-- por `e.nome = 'Tanelas FooD'`, mas `empresas.nome` e editavel pelo proprio
-- cliente (PUT /empresa, campo "Razao social" nas Configuracoes). Se o nome
-- mudar entre esta migration ser escrita e o deploy rodar, os tres comandos
-- casariam ZERO linhas — sem erro nenhum (UPDATE/INSERT de 0 linhas e
-- sucesso em SQL) — e a empresa acordaria sem `config.plano`, caindo no
-- default 'basico' e perdendo Estoque/Caixa/Financeiro em silencio. Corrigido
-- chaveando pelo id (imutavel, confirmado direto em producao) em vez do
-- nome, e abortando a migration inteira (o `RAISE EXCEPTION` derruba a
-- transacao, e o boot do container falha alto — ver docker/entrypoint.sh)
-- se por algum motivo essa empresa nao for encontrada, em vez de aplicar
-- silenciosamente 0 linhas.
do $$
declare
  v_id constant uuid := '54fea933-892e-4d55-b899-e244e69733a7';
begin
  if not exists (select 1 from public.empresas where id = v_id) then
    raise exception 'Migration 0032 abortada: empresa Tanelas FooD (id %) nao encontrada — nunca aplicar esta migration silenciosamente sem essa empresa existir.', v_id;
  end if;
end $$;

alter table public.assinaturas
  add constraint assinaturas_plano_valido check (plano in ('basico', 'completo'));

-- Se ja existe assinatura pra Tanelas FooD (pode ter sido configurada
-- manualmente pelo Painel ETNA antes deste plano formal existir — como
-- de fato aconteceu, 2026-08-24), so ATUALIZA o plano pra completo,
-- preservando valor/dia_vencimento/proximo_vencimento/status reais.
-- Nunca tirar acesso de quem ja usa Estoque/Caixa (Global Constraint).
update public.assinaturas a
set plano = 'completo', updated_at = now()
where a.empresa_id = '54fea933-892e-4d55-b899-e244e69733a7' and a.plano <> 'completo';

-- So cria uma assinatura nova (valores provisorios) se a empresa
-- genuinamente nao tiver nenhuma linha em assinaturas ainda.
insert into public.assinaturas (id, empresa_id, plano, valor, dia_vencimento, proximo_vencimento, status, observacoes)
select gen_random_uuid(), '54fea933-892e-4d55-b899-e244e69733a7', 'completo', 0, 10, (current_date + interval '30 days')::date, 'ativa',
       'Migrada automaticamente para completo na migration 0032 — ja usava Estoque/Caixa antes de existir plano formal.'
where not exists (
  select 1 from public.assinaturas where empresa_id = '54fea933-892e-4d55-b899-e244e69733a7'
);

-- Espelha o plano em empresas.config (mesmo campo que temModulo() vai ler)
-- para a Tanelas FooD especificamente, ja que o codigo que sincroniza isso
-- automaticamente (Task 4) so entra em vigor a partir do proximo deploy.
update public.empresas
set config = jsonb_set(coalesce(config, '{}'::jsonb), '{plano}', '"completo"'::jsonb)
where id = '54fea933-892e-4d55-b899-e244e69733a7';
