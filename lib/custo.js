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

/** Rotulos dos canais de venda, na ordem em que o dono pensa neles. */
export const CANAIS = {
  balcao: 'Balcão',
  mesa: 'Mesa',
  delivery: 'Delivery',
  retirada: 'Retirada',
}

/**
 * Margem BRUTA por canal de venda (balcao, mesa, delivery, retirada).
 *
 * Responde a pergunta que o total esconde: "o delivery esta pagando o que
 * custa?". Taxa de app, embalagem e combustivel corroem a margem do delivery,
 * e no numero consolidado isso some dentro do faturamento do salao.
 *
 * BRUTA, nao liquida, e a distincao importa: usa o custo de mercadoria
 * congelado na venda (`custo_total`), que e atribuivel ao pedido. Aluguel,
 * folha e energia NAO sao rateados por canal — qualquer rateio seria uma regra
 * inventada por nos, e um numero inventado num relatorio financeiro e pior que
 * um numero ausente.
 *
 * So `tipo === 'receita'` entra, mesma regra do `computeCMV`: estorno e
 * despesa e nao devolve mercadoria.
 *
 * @param {object} p
 * @param {Array} p.transacoes transacoes ja filtradas pelo periodo
 * @param {Array<{id: string, tipo: string, entrega_taxa?: number}>} p.pedidos pedidos do mesmo periodo
 */
export function computeMargemPorCanal({ transacoes, pedidos }) {
  const canalDoPedido = new Map()
  const taxaDoPedido = new Map()
  for (const p of pedidos || []) {
    canalDoPedido.set(p.id, p.tipo || 'balcao')
    taxaDoPedido.set(p.id, Number(p.entrega_taxa || 0))
  }

  const buckets = new Map()
  const bucket = (canal) => {
    if (!buckets.has(canal)) {
      buckets.set(canal, {
        canal, label: CANAIS[canal] || canal,
        receita_base: 0, receita_com_custo: 0, custo_total: 0,
        taxa_entrega: 0, pedidos: new Set(),
      })
    }
    return buckets.get(canal)
  }

  // Receita que nao veio de pedido (lancamento manual de caixa, ajuste). Fica
  // FORA do rateio por canal e e reportada a parte: somar num canal qualquer
  // inventaria uma origem, e escondê-la faria os canais nao fecharem com a
  // receita do DRE sem explicacao.
  let receitaSemCanal = 0

  for (const t of transacoes || []) {
    if (t.tipo !== 'receita') continue
    const canal = t.pedido_id ? canalDoPedido.get(t.pedido_id) : undefined
    if (!canal) { receitaSemCanal += Number(t.valor || 0); continue }
    const b = bucket(canal)
    b.receita_base += Number(t.receita_base || 0)
    b.receita_com_custo += Number(t.receita_com_custo || 0)
    b.custo_total += Number(t.custo_total || 0)
    b.pedidos.add(t.pedido_id)
  }

  // Taxa de entrega e receita de SERVICO, nao de mercadoria: fica fora do
  // calculo de CMV (mesma razao documentada em `computeCustoVenda`) e aparece
  // em coluna propria, para o dono ver quanto do delivery e frete.
  for (const [pedidoId, canal] of canalDoPedido) {
    const taxa = taxaDoPedido.get(pedidoId) || 0
    if (taxa > 0 && buckets.has(canal)) buckets.get(canal).taxa_entrega += taxa
  }

  const canais = [...buckets.values()].map((b) => {
    const qtdPedidos = b.pedidos.size
    return {
      canal: b.canal,
      label: b.label,
      pedidos: qtdPedidos,
      receita_base: round2(b.receita_base),
      receita_com_custo: round2(b.receita_com_custo),
      custo_total: round2(b.custo_total),
      taxa_entrega: round2(b.taxa_entrega),
      ticket_medio: qtdPedidos > 0 ? round2(b.receita_base / qtdPedidos) : 0,
      // `null` quando nao ha custo apurado: "nao da para saber" e diferente de
      // "a margem e zero", e a tela precisa distinguir.
      lucro_bruto: b.receita_com_custo > 0 ? round2(b.receita_com_custo - b.custo_total) : null,
      margem_percent: b.receita_com_custo > 0
        ? round2(((b.receita_com_custo - b.custo_total) / b.receita_com_custo) * 100)
        : null,
      cobertura_percent: b.receita_base > 0
        ? round2((b.receita_com_custo / b.receita_base) * 100)
        : null,
    }
  }).sort((a, b) => b.receita_base - a.receita_base)

  return { canais, receita_sem_canal: round2(receitaSemCanal) }
}
