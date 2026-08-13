/**
 * Calculo do valor esperado na gaveta do caixa.
 *
 * Modulo puro: nao toca banco, nao toca HTTP. Existe separado para que a
 * formula viva em um lugar so — o fechamento e a validacao de sangria
 * precisam exatamente do mesmo numero.
 *
 * So DINHEIRO entra na conta. PIX e cartao caem na conta bancaria e nunca
 * estao na gaveta para serem contados.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param {object} p
 * @param {number} p.valor_abertura fundo de troco
 * @param {Array<{tipo: string, categoria: string, forma_pagamento: string, valor: number}>} p.transacoes
 * @param {Array<{tipo: string, valor: number}>} p.movimentos
 */
export function computeCaixaEsperado({ valor_abertura, transacoes, movimentos }) {
  const abertura = round2(valor_abertura)
  const trans = transacoes || []
  const movs = movimentos || []

  const ehDinheiro = (t) => t.forma_pagamento === 'dinheiro'

  const receitas_dinheiro = round2(
    trans.filter((t) => t.tipo === 'receita' && ehDinheiro(t))
      .reduce((s, t) => s + Number(t.valor || 0), 0)
  )

  const estornos_dinheiro = round2(
    trans.filter((t) => t.tipo === 'despesa' && t.categoria === 'Estorno' && ehDinheiro(t))
      .reduce((s, t) => s + Number(t.valor || 0), 0)
  )

  const suprimentos = round2(
    movs.filter((m) => m.tipo === 'suprimento').reduce((s, m) => s + Number(m.valor || 0), 0)
  )

  const sangrias = round2(
    movs.filter((m) => m.tipo === 'sangria').reduce((s, m) => s + Number(m.valor || 0), 0)
  )

  // Resumo de TODAS as receitas por metodo — usado pela tela de fechamento e,
  // depois, pelo grafico de pizza dos relatorios. Inclui pix e cartao, que nao
  // entram no esperado da gaveta mas o operador precisa ver.
  const por_forma_pagamento = {}
  for (const t of trans) {
    if (t.tipo !== 'receita') continue
    const forma = t.forma_pagamento || 'nao_informado'
    por_forma_pagamento[forma] = round2((por_forma_pagamento[forma] || 0) + Number(t.valor || 0))
  }

  const valor_esperado = round2(
    abertura + receitas_dinheiro - estornos_dinheiro + suprimentos - sangrias
  )

  return {
    valor_abertura: abertura,
    receitas_dinheiro,
    estornos_dinheiro,
    suprimentos,
    sangrias,
    valor_esperado,
    por_forma_pagamento,
  }
}
