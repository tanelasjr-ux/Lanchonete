-- ============================================================================
-- Restaurant OS :: Migration 0023 :: Retrocompatibilidade das feature flags
-- ============================================================================
-- Contexto: ate agora as flags em `empresas.config.feature_flags` eram
-- decorativas — nenhum endpoint as lia. Por isso elas nasceram erradas e
-- ninguem notou: o signup gravava `estoque: false` e `caixa: false` mesmo
-- entregando os dois modulos funcionando.
--
-- A partir do commit que acompanha esta migration as flags VALEM: `false`
-- devolve 403. Sem este backfill, a primeira empresa a subir com o codigo
-- novo perderia Estoque e Caixa instantaneamente — modulos que ela usa hoje.
-- Auditado antes de escrever: a empresa de producao tinha `estoque: false` e
-- `caixa: false` gravados E AO MESMO TEMPO produtos com estoque habilitado e
-- caixas no historico.
--
-- Direcao deliberada: esta migration so LIGA modulo, nunca desliga. Ligar a
-- mais devolve um modulo que a empresa ja usava; desligar a mais tira o chao
-- de uma operacao em funcionamento no meio do expediente. Os erros nao tem o
-- mesmo peso, entao a migration nao os trata como equivalentes.
--
-- Idempotente: reaplicar nao muda nada alem do que ja esta ligado.

-- Empresas sem `config` ou sem `feature_flags`: recebem o conjunto padrao.
-- (`temModulo` ja trata ausencia como ligado, mas dado explicito e o que a
-- tela de Modulos consegue exibir e o dono consegue conferir.)
update public.empresas
set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
  'feature_flags', jsonb_build_object(
    'mesas', true, 'comandas', true, 'estoque', true, 'caixa', true,
    'crm', false, 'campanhas', false, 'fidelidade', false,
    'cashback', false, 'multiunidade', false, 'billing', false
  )
)
where config->'feature_flags' is null;

-- Empresas que ja tem o bloco: liga os quatro modulos entregues hoje,
-- preservando qualquer outra chave que exista ali.
update public.empresas
set config = jsonb_set(
  config,
  '{feature_flags}',
  config->'feature_flags' || jsonb_build_object(
    'mesas', true, 'comandas', true, 'estoque', true, 'caixa', true
  )
)
where config->'feature_flags' is not null
  and not (
    coalesce((config->'feature_flags'->>'mesas')::boolean, false)
    and coalesce((config->'feature_flags'->>'comandas')::boolean, false)
    and coalesce((config->'feature_flags'->>'estoque')::boolean, false)
    and coalesce((config->'feature_flags'->>'caixa')::boolean, false)
  );

-- As flags dos modulos ainda nao implementados so sao criadas se faltarem —
-- uma empresa que (no futuro) contratou CRM nao pode ser desligada por aqui.
update public.empresas
set config = jsonb_set(
  config,
  '{feature_flags}',
  jsonb_build_object(
    'crm', false, 'campanhas', false, 'fidelidade', false,
    'cashback', false, 'multiunidade', false, 'billing', false
  ) || config->'feature_flags'
)
where config->'feature_flags' is not null;
