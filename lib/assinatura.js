/**
 * Assinatura (mensalidade que o restaurante paga para a ETNA).
 * ---------------------------------------------------------------------------
 * Modulo puro: nao toca banco, nao toca HTTP. Mesmo espirito de lib/contas.js
 * e lib/custo.js — a regra vive num lugar so, testada isolada.
 *
 * NAO confundir com lib/contas.js: aquele e o contas a pagar/receber DO
 * RESTAURANTE (fornecedor dele, aluguel dele). Este e o dinheiro que o
 * restaurante paga PARA A ETNA.
 *
 * Regra de aviso, decidida explicitamente pelo dono (2026-08-18): "nao avise
 * com antecedencia o cliente, avise somente apos o atraso". Por isso NAO HA
 * tier de "vence em breve" — o cliente so ouve falar da mensalidade quando
 * ela ja passou do dia.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Dias corridos de atraso, em CALENDARIO UTC — mesma disciplina de
 * `statusEfetivo()` em lib/contas.js, pela mesma razao: vencimento e uma
 * data, nao um instante, e comparar em hora local quebra perto da virada do
 * dia dependendo do fuso do servidor (achado real, ja documentado ali).
 *
 * @param {string} proximoVencimento `"YYYY-MM-DD"`
 * @param {Date} hoje
 * @returns {number} 0 = vence hoje ou ainda nao venceu; positivo = dias de atraso
 */
export function diasDeAtraso(proximoVencimento, hoje = new Date()) {
  const hojeUTC = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  const venc = new Date(proximoVencimento)
  const vencUTC = Date.UTC(venc.getUTCFullYear(), venc.getUTCMonth(), venc.getUTCDate())
  const diffDias = Math.round((hojeUTC - vencUTC) / 86400000)
  return Math.max(0, diffDias)
}

/**
 * Status efetivo da assinatura. `'cancelada'` e o unico gravado que nunca e
 * recalculado; `'ativa'` gravada pode virar `'atrasada'` na leitura — mesma
 * regra de "atrasada nunca e gravada" de `contas.status_efetivo` (migration
 * 0025) e pelo mesmo motivo: um status de atraso gravado exigiria um robo
 * virando o registro todo dia, e um unico dia sem esse robo rodar deixaria a
 * carteira inteira mentindo.
 *
 * @param {{status: string, proximo_vencimento: string}} assinatura
 * @param {Date} hoje
 * @returns {'ativa'|'atrasada'|'cancelada'}
 */
export function statusEfetivo(assinatura, hoje = new Date()) {
  if (assinatura.status !== 'ativa') return assinatura.status
  return diasDeAtraso(assinatura.proximo_vencimento, hoje) > 0 ? 'atrasada' : 'ativa'
}

/**
 * `true` enquanto o aviso ao cliente estiver pausado (cortesia concedida
 * pelo dono, 2026-08-19: "pausar o aviso... caso eu queira dar um mes de
 * cortesia"). Mesma disciplina UTC de `diasDeAtraso()` — `aviso_pausado_ate`
 * e data pura, nao instante.
 *
 * NAO mexe em `statusEfetivo()`: a assinatura continua "atrasada" de
 * verdade no Painel da Plataforma (conta em "valor em atraso") — a pausa
 * so esconde o AVISO que o cliente ve, nunca o controle do dono sobre a
 * propria carteira. Passada a data, o aviso volta sozinho no dia
 * seguinte — nao ha estado "pausa ativa" para alguem esquecer de desligar.
 *
 * @param {{aviso_pausado_ate?: string|null}} assinatura
 * @param {Date} hoje
 */
function avisoPausado(assinatura, hoje) {
  if (!assinatura.aviso_pausado_ate) return false
  const hojeUTC = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  const pausa = new Date(assinatura.aviso_pausado_ate)
  const pausaUTC = Date.UTC(pausa.getUTCFullYear(), pausa.getUTCMonth(), pausa.getUTCDate())
  return hojeUTC <= pausaUTC
}

/**
 * Escada de aviso mostrada AO CLIENTE (o restaurante), dentro do proprio
 * sistema dele. So tem degrau A PARTIR do vencimento — nunca antes, por
 * decisao explicita do dono. `null` = nada a mostrar.
 *
 * O BLOQUEIO (travar modulo ou acesso inteiro) nunca acontece aqui: e
 * decisao manual do dono, tomada no Painel da Plataforma (route.js,
 * /plataforma/*). Esta funcao so decide o TOM do aviso — o efeito de
 * bloquear de fato mora em `empresas.ativo` e em `config.feature_flags`
 * (lib/modulos.js), nunca derivado da assinatura sozinha.
 *
 * @param {{status: string, proximo_vencimento: string, aviso_pausado_ate?: string|null}} assinatura
 * @param {Date} hoje
 */
export function avisoParaCliente(assinatura, hoje = new Date()) {
  if (assinatura.status !== 'ativa') return null
  if (avisoPausado(assinatura, hoje)) return null
  const dias = diasDeAtraso(assinatura.proximo_vencimento, hoje)
  if (dias <= 0) return null
  if (dias <= 3) {
    return {
      nivel: 'amber',
      dias,
      titulo: 'Mensalidade em aberto',
      mensagem: 'A mensalidade ainda não caiu por aqui. Se já pagou, pode ignorar — a confirmação pode levar até 1 dia útil.',
    }
  }
  return {
    nivel: 'vermelho',
    dias,
    titulo: 'Mensalidade atrasada',
    mensagem: `A mensalidade está atrasada há ${dias} dias. Fale com a gente para regularizar e evitar qualquer interrupção no sistema.`,
  }
}

/**
 * Resumo agregado para a lista de empresas do Painel da Plataforma —
 * mesmo papel de `resumoContas()` em lib/contas.js.
 *
 * @param {Array<{status_efetivo: string, valor: number}>} assinaturas ja com status_efetivo calculado
 */
export function resumoCarteira(assinaturas) {
  const ativas = (assinaturas || []).filter((a) => a.status_efetivo === 'ativa')
  const atrasadas = (assinaturas || []).filter((a) => a.status_efetivo === 'atrasada')
  const soma = (lista) => round2(lista.reduce((s, a) => s + Number(a.valor || 0), 0))
  return {
    ativas_qtd: ativas.length,
    ativas_mrr: soma(ativas) + soma(atrasadas), // MRR conta quem deveria estar pagando, atrasado ou nao
    atrasadas_qtd: atrasadas.length,
    atrasadas_valor: soma(atrasadas),
  }
}
