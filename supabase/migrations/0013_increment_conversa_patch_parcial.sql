-- ============================================================================
-- Restaurant OS :: Migration 0013 :: correcao encontrada ao validar os
-- repositories contra o projeto Supabase REAL (nao o PostgREST local)
-- ----------------------------------------------------------------------------
-- Achado: `increment_conversa_nao_lidas()` (migration 0009) declarava os 5
-- parametros como obrigatorios e sem default. Dois problemas reais:
--
-- 1. `supabase-js` remove chaves `undefined` do corpo JSON antes de enviar.
--    Se o Service chamar `incrementarNaoLidas()` com um patch PARCIAL (ex.:
--    so `{ ultima_mensagem }`), a chamada chega no PostgREST com 3 dos 5
--    parametros e nao casa com nenhuma assinatura -> erro PGRST202
--    ("Could not find the function ... in the schema cache"), um erro
--    confuso e dificil de diagnosticar em producao. O fluxo atual do
--    route.js sempre passa os 3 campos, entao isso nunca disparou ate
--    agora - mas e uma armadilha esperando o primeiro caller parcial.
--
-- 2. Mesmo que casasse, o `update` sobrescreveria os campos omitidos com
--    NULL. Isso NAO e equivalente ao `$set` do Mongo, que so altera os
--    campos efetivamente passados - e o contrato que o repository Supabase
--    precisa espelhar (`patch: Partial<Conversa>` em domain.ts).
--
-- Correcao: defaults `null` nos 3 campos opcionais + `coalesce(param, coluna)`
-- no update, para que um campo ausente preserve o valor atual em vez de
-- apaga-lo. O incremento de `nao_lidas` continua igual (e o unico efeito
-- sempre aplicado, que da nome a funcao). Continua mecanica: nao decide
-- nenhum valor de negocio, so aplica o que o Service passou.
-- ============================================================================

create or replace function public.increment_conversa_nao_lidas(
  p_empresa_id uuid,
  p_conversa_id uuid,
  p_ultima_mensagem text default null,
  p_ultima_mensagem_em timestamptz default null,
  p_status text default null
)
returns void language sql as $$
  update public.conversas
  set ultima_mensagem = coalesce(p_ultima_mensagem, ultima_mensagem),
      ultima_mensagem_em = coalesce(p_ultima_mensagem_em, ultima_mensagem_em),
      status = coalesce(p_status, status),
      nao_lidas = nao_lidas + 1,
      updated_at = now()
  where id = p_conversa_id and empresa_id = p_empresa_id;
$$;
