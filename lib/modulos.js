/**
 * Restaurant OS :: Modulos (feature flags que realmente controlam acesso)
 * ============================================================================
 * Ate 2026-08-18 as flags em `empresas.config.feature_flags` eram decorativas:
 * existiam desde o signup, apareciam numa aba "Modulos" com badge Ativo/Em
 * breve, e NENHUM dos 81 endpoints as consultava. Desligar "Estoque" na tela
 * nao desligava o Estoque. A autorizacao olhava so `can(papel, modulo)` —
 * papel, nunca plano contratado.
 *
 * Sem isto nao existe plano Basico e plano Pro: nao da para cobrar mais por um
 * modulo que nao pode ser desligado. Por isso este arquivo e pre-requisito do
 * billing (B3 do programa de profissionalizacao).
 *
 * Este modulo e o unico lugar que decide se uma empresa tem acesso a algo por
 * PLANO. Papel continua com `can()` em route.js — as duas checagens sao
 * independentes e ambas precisam passar:
 *   - `temModulo(empresa, 'caixa')` -> a empresa contratou o modulo?
 *   - `can(ctx.papel, 'financeiro')` -> este usuario pode mexer nele?
 */

/**
 * Modulos que podem ser ligados/desligados HOJE, porque tem endpoint e tela
 * de verdade por tras. Cada um lista as flags que o interruptor controla.
 *
 * O que NAO esta aqui (crm, campanhas, fidelidade, cashback, billing,
 * multiunidade) continua sem implementacao nenhuma. Ficam como "Em breve" na
 * tela, sem interruptor: um botao que promete ligar algo inexistente e pior
 * que a ausencia do botao — foi exatamente essa mentira (flag que nao
 * controlava nada) que este arquivo veio corrigir.
 */
export const MODULOS = {
  mesas: {
    label: 'Mesas & Comandas',
    descricao: 'Salao com mesas, comandas abertas e fechamento por mesa.',
    // Uma comanda so existe em cima de uma mesa neste produto, entao o
    // interruptor escreve as duas flags juntas — deixar `comandas` ligada com
    // `mesas` desligada criaria a mesma incoerencia que estamos consertando.
    flags: ['mesas', 'comandas'],
  },
  estoque: {
    label: 'Estoque',
    descricao: 'Baixa automatica por venda, minimo por produto e alerta de reposicao.',
    flags: ['estoque'],
  },
  caixa: {
    label: 'Caixa',
    descricao: 'Abertura, sangria, suprimento e conferencia de fechamento.',
    flags: ['caixa'],
  },
}

/** Modulos listados na tela mas ainda sem implementacao — badge, nunca interruptor. */
export const MODULOS_EM_BREVE = [
  ['crm', 'CRM'],
  ['campanhas', 'Campanhas'],
  ['fidelidade', 'Fidelidade'],
  ['cashback', 'Cashback'],
  ['multiunidade', 'Multiunidades'],
  ['billing', 'Billing SaaS'],
]

/**
 * A empresa tem acesso a este modulo?
 *
 * REGRA CRITICA: so `false` explicito desliga. Flag ausente, `null`, config
 * inexistente — tudo isso conta como LIGADO.
 *
 * A direcao do default nao e estilo, e seguranca de dados: ausencia de
 * informacao nunca pode tirar acesso de quem ja usa o modulo. Quando este
 * gate entrou, a unica empresa de producao tinha `estoque: false` e
 * `caixa: false` gravados desde o signup e AO MESMO TEMPO produtos com
 * estoque habilitado e caixas fechados no historico — as flags nasceram
 * erradas justamente porque ninguem as lia. A migration 0023 corrige os
 * dados; este default protege quem a migration nao alcancar (backup restaurado,
 * empresa criada por script antigo, config truncada).
 */
export function temModulo(empresa, modulo) {
  const flags = empresa?.config?.feature_flags
  if (!flags) return true
  return flags[modulo] !== false
}

/**
 * Flags que o signup deve gravar numa empresa nova. Precisa refletir o que o
 * produto ENTREGA hoje, nao o que se pretende cobrar amanha: gravar `false`
 * num modulo que funciona foi a origem do bug que este arquivo corrige.
 */
export function flagsPadraoSignup() {
  const flags = {}
  for (const mod of Object.values(MODULOS)) {
    for (const f of mod.flags) flags[f] = true
  }
  for (const [chave] of MODULOS_EM_BREVE) flags[chave] = false
  return flags
}

/** Resumo {modulo: bool} para o front decidir navegacao e chamadas. */
export function modulosAtivos(empresa) {
  const out = {}
  for (const chave of Object.keys(MODULOS)) out[chave] = temModulo(empresa, chave)
  return out
}
