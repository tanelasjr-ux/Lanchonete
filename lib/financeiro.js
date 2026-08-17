/**
 * DRE simplificado (Demonstrativo de Resultado) e ponto de equilibrio.
 *
 * Modulo puro, no mesmo espirito de `lib/custo.js`: nao toca banco, nao toca
 * HTTP. A formula vive em um lugar so, testada isolada.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Vocabulario fixo de categoria de despesa, com natureza padrao sugerida.
 *
 * Texto livre (como era ate 2026-08-18) faz "Aluguel", "aluguel" e "ALUGUEL"
 * virarem tres categorias diferentes e nenhum agrupamento funcionar de
 * verdade. A natureza e sugestao, nao trava: o dono pode classificar uma
 * transacao especifica diferente do padrao da categoria (ex: "Manutencao"
 * emergencial pontual pode ser variavel mesmo a categoria sendo fixa por
 * padrao) — por isso o dialog de lancamento manda `natureza` explicito,
 * nao deriva da categoria no servidor.
 */
export const CATEGORIAS_DESPESA = [
  { valor: 'Insumos', natureza_sugerida: 'variavel' },
  { valor: 'Embalagens', natureza_sugerida: 'variavel' },
  { valor: 'Combustivel e Entrega', natureza_sugerida: 'variavel' },
  { valor: 'Taxas e Comissoes', natureza_sugerida: 'variavel' },
  { valor: 'Pessoal', natureza_sugerida: 'fixa' },
  { valor: 'Aluguel', natureza_sugerida: 'fixa' },
  { valor: 'Energia e Agua', natureza_sugerida: 'fixa' },
  { valor: 'Manutencao', natureza_sugerida: 'fixa' },
  { valor: 'Marketing', natureza_sugerida: 'fixa' },
  { valor: 'Impostos', natureza_sugerida: 'fixa' },
  { valor: 'Estorno', natureza_sugerida: null }, // gerado pelo sistema (ver route.js), nao pelo dono
  { valor: 'Outros', natureza_sugerida: null },
]

/**
 * Agrega transacoes de despesa por categoria, dentro do periodo ja filtrado
 * pelo chamador.
 *
 * @param {Array<{tipo: string, categoria: string, natureza: string|null, valor: number}>} transacoes
 */
export function agruparDespesasPorCategoria(transacoes) {
  const despesas = (transacoes || []).filter((t) => t.tipo === 'despesa')
  const porCategoria = new Map()

  for (const t of despesas) {
    const categoria = t.categoria || 'Outros'
    const atual = porCategoria.get(categoria) || { categoria, valor: 0, natureza: t.natureza || null }
    atual.valor = round2(atual.valor + Number(t.valor || 0))
    // Categoria pode ter lancamentos com natureza diferente entre si (dono
    // mudou de ideia, ou classificou parcialmente); guarda a do primeiro e
    // marca divergencia em vez de fingir consenso.
    if (atual.natureza !== (t.natureza || null)) atual.natureza = 'mista'
    porCategoria.set(categoria, atual)
  }

  return [...porCategoria.values()].sort((a, b) => b.valor - a.valor)
}

/**
 * DRE simplificado: receita -> CMV -> lucro bruto -> despesas operacionais
 * (fixas + variaveis) -> lucro liquido.
 *
 * `cmv.custo_total` ja vem calculado (lib/custo.js) e cobre so mercadoria —
 * nunca duplicar com despesas de categoria "Insumos" lancadas manualmente,
 * que sao OUTRA coisa (compra de insumo nao ligada a um produto vendido
 * especifico, ex: reposicao de estoque). Os dois aparecem separados no DRE de
 * proposito: CMV e o custo do que foi VENDIDO, despesas de insumo sao o custo
 * do que foi COMPRADO — podem nao bater no mesmo periodo.
 *
 * @param {{custo_total: number, receita_com_custo: number}} cmv
 * @param {number} receitaTotal receita bruta do periodo (todas as transacoes tipo=receita)
 * @param {Array<{categoria: string, valor: number, natureza: string|null}>} despesasPorCategoria
 */
export function computeDRE({ cmv, receitaTotal, despesasPorCategoria }) {
  const custoMercadoria = round2(cmv?.custo_total || 0)
  const lucroBruto = round2(receitaTotal - custoMercadoria)

  let despesasFixas = 0
  let despesasVariaveis = 0
  let despesasNaoClassificadas = 0
  for (const d of despesasPorCategoria || []) {
    if (d.natureza === 'fixa') despesasFixas += d.valor
    else if (d.natureza === 'variavel') despesasVariaveis += d.valor
    else despesasNaoClassificadas += d.valor // null ou 'mista'
  }
  despesasFixas = round2(despesasFixas)
  despesasVariaveis = round2(despesasVariaveis)
  despesasNaoClassificadas = round2(despesasNaoClassificadas)

  const totalDespesasOperacionais = round2(despesasFixas + despesasVariaveis + despesasNaoClassificadas)
  const lucroLiquido = round2(lucroBruto - totalDespesasOperacionais)

  // Ponto de equilibrio: receita mensal minima para nao operar no prejuizo.
  // PE = custos_fixos / margem_de_contribuicao, onde margem de contribuicao e
  // a fracao de cada real vendido que sobra depois dos custos que escalam com
  // a venda (mercadoria + despesa variavel).
  //
  // So calculavel com receita > 0 (senao margem e indefinida), custo variavel
  // < receita (senao a margem e zero ou negativa e o "ponto de equilibrio"
  // formal seria infinito ou negativo — numero sem sentido pratico) E
  // despesasFixas > 0. Este ultimo NAO e so evitar divisao por zero
  // (0 / margem = 0, que calcularia sem erro): e a mesma logica de nao
  // adivinhar de `produtos.custo` (0020) — `despesasFixas === 0` quase sempre
  // significa "nenhuma despesa foi classificada como fixa ainda", nao
  // "este restaurante genuinamente nao tem aluguel nem folha". Mostrar
  // "ponto de equilibrio: R$ 0" seria uma mentira mais convincente (e mais
  // perigosa) do que nao mostrar nada.
  const custoVariavelTotal = round2(custoMercadoria + despesasVariaveis)
  const margemContribuicao = receitaTotal > 0 ? (receitaTotal - custoVariavelTotal) / receitaTotal : 0
  const pontoEquilibrio = receitaTotal > 0 && margemContribuicao > 0 && despesasFixas > 0
    ? round2(despesasFixas / margemContribuicao)
    : null

  return {
    receita_total: round2(receitaTotal),
    custo_mercadoria: custoMercadoria,
    lucro_bruto: lucroBruto,
    despesas_fixas: despesasFixas,
    despesas_variaveis: despesasVariaveis,
    despesas_nao_classificadas: despesasNaoClassificadas,
    total_despesas_operacionais: totalDespesasOperacionais,
    lucro_liquido: lucroLiquido,
    margem_liquida_percent: receitaTotal > 0 ? round2((lucroLiquido / receitaTotal) * 100) : null,
    ponto_equilibrio: pontoEquilibrio,
  }
}
