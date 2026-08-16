/**
 * Custo de mercadoria vendida (CMV) e margem.
 *
 * Modulo puro: nao toca banco, nao toca HTTP. Existe separado para que a
 * formula viva em um lugar so — os tres pontos de venda apuram com a mesma
 * regra, e o Dashboard e o Relatorio agregam com a mesma regra.
 *
 * Produto sem custo cadastrado (`null`) NAO entra na conta. Produto com custo
 * `0` entra. Essa distincao e o que permite reportar cobertura em vez de um
 * CMV falsamente baixo.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Apura o custo de uma venda a partir dos itens e do custo cadastrado de cada
 * produto.
 *
 * `receita_base` e o subtotal dos itens (`preco * quantidade`). Desconto,
 * acrescimo e taxa de entrega ficam de fora de proposito: CMV compara custo de
 * mercadoria com receita de mercadoria — taxa de entrega e receita de servico e
 * desconto e ajuste comercial. Misturar distorceria o indicador.
 *
 * @param {object} p
 * @param {Array<{produto_id: string|null, preco: number, quantidade: number}>} p.itens
 * @param {Object<string, number|null>} p.custoPorProduto mapa produto_id -> custo
 * @param {number} p.rateio fracao desta transacao sobre o total da venda.
 *   Comanda paga em dois metodos gera duas transacoes; cada uma leva sua fatia,
 *   e a soma dos rateios e 1, entao qualquer soma dos campos continua exata.
 * @returns {{custo_total: number, receita_com_custo: number, receita_base: number}}
 */
export function computeCustoVenda({ itens, custoPorProduto, rateio = 1 }) {
  const lista = itens || []
  const custos = custoPorProduto || {}
  // Divisao por zero no chamador (comanda de total zero) viraria Infinity ou
  // NaN e contaminaria o banco. Aqui vira 0.
  const fracao = Number.isFinite(Number(rateio)) ? Number(rateio) : 0

  let custo_total = 0
  let receita_com_custo = 0
  let receita_base = 0

  for (const item of lista) {
    const quantidade = Number(item.quantidade || 0)
    const linha = Number(item.preco || 0) * quantidade
    receita_base += linha

    if (!item.produto_id) continue

    const custo = custos[item.produto_id]
    // `null`/`undefined` = nao cadastrado, fica fora. `0` = custo zero real,
    // entra. Nao trocar por `if (!custo)`, que descartaria o zero.
    if (custo === null || custo === undefined) continue

    custo_total += Number(custo) * quantidade
    receita_com_custo += linha
  }

  return {
    custo_total: round2(custo_total * fracao),
    receita_com_custo: round2(receita_com_custo * fracao),
    receita_base: round2(receita_base * fracao),
  }
}

/**
 * Agrega transacoes ja gravadas em indicadores de gestao.
 *
 * So `tipo === 'receita'` entra: estorno e despesa e nao devolve custo — a
 * comida foi produzida e perdida, o custo aconteceu de verdade. Efeito pratico:
 * estorno piora o CMV, que e o sinal correto.
 *
 * @param {Array<{tipo: string, custo_total: number, receita_com_custo: number, receita_base: number}>} transacoes
 */
export function computeCMV(transacoes) {
  const receitas = (transacoes || []).filter((t) => t.tipo === 'receita')
  const soma = (campo) => round2(receitas.reduce((s, t) => s + Number(t[campo] || 0), 0))

  const custo_total = soma('custo_total')
  const receita_com_custo = soma('receita_com_custo')
  const receita_base = soma('receita_base')

  // `null`, nunca `0`: "nao da para saber" e diferente de "e zero", e a UI
  // precisa distinguir para mostrar o estado vazio certo no primeiro dia de uso.
  const cmv_percent = receita_com_custo > 0
    ? round2((custo_total / receita_com_custo) * 100)
    : null
  const lucro_bruto = receita_com_custo > 0
    ? round2(receita_com_custo - custo_total)
    : null
  const cobertura_percent = receita_base > 0
    ? round2((receita_com_custo / receita_base) * 100)
    : null

  return {
    custo_total,
    receita_com_custo,
    receita_base,
    cmv_percent,
    cobertura_percent,
    lucro_bruto,
  }
}
