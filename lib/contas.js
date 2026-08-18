/**
 * Contas a pagar/receber — camada de OBRIGACAO (o que ainda vai acontecer),
 * complementar a `transacoes` (a camada de CAIXA — o que ja aconteceu).
 *
 * Marcar uma conta como paga cria a transacao que alimenta DRE/CMV/relatorio
 * (route.js); antes disso a conta nao aparece em nenhum numero do relatorio
 * financeiro, de proposito — misturar as duas camadas inflaria receita ou
 * despesa com dinheiro que ainda nao mudou de mao.
 *
 * Modulo puro: nao toca banco, nao toca HTTP. Mesmo espirito de lib/custo.js
 * e lib/financeiro.js.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * "Atrasada" NUNCA e gravada no banco — e sempre derivada de
 * `vencimento < hoje && status === 'pendente'`. Guardar como coluna exigiria
 * um job rodando todo dia so para virar o status sozinho, e um unico dia sem
 * esse job deixaria a lista inteira mentindo. Calcular na leitura nunca fica
 * desatualizado, e o mesmo calculo roda aqui (servidor) e nunca precisa ser
 * reimplementado no front — `GET /contas` ja devolve `status_efetivo` pronto.
 *
 * A comparacao e feita em CALENDARIO UTC dos dois lados, nunca em hora local.
 * `vencimento` e uma data pura ("2026-08-18") e o motor JS SEMPRE le isso como
 * meia-noite UTC — comparar contra "hoje" zerado em hora LOCAL quebra sempre
 * que o servidor roda num fuso atras de UTC: um vencimento genuinamente hoje
 * cai antes da meia-noite local (que, convertida para UTC, e mais tarde que
 * meia-noite UTC) e e classificado como atrasado por engano. Achado escrevendo
 * o teste `vencimento_hoje_nao_e_atrasada` — o bug era real, nao o teste.
 *
 * @param {{status: string, vencimento: string|Date}} conta
 * @param {Date} hoje
 */
export function statusEfetivo(conta, hoje = new Date()) {
  if (conta.status !== 'pendente') return conta.status
  const hojeUTC = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  const venc = new Date(conta.vencimento)
  const vencUTC = Date.UTC(venc.getUTCFullYear(), venc.getUTCMonth(), venc.getUTCDate())
  return vencUTC < hojeUTC ? 'atrasada' : 'pendente'
}

/**
 * Resumo agregado para o card "contas a vencer" e para o topo da listagem.
 * Espera contas ja com `status_efetivo` calculado (`statusEfetivo` acima).
 *
 * @param {Array} contas
 * @param {Date} hoje
 */
export function resumoContas(contas, hoje = new Date()) {
  const abertas = (contas || []).filter((c) => c.status === 'pendente')
  const soma = (lista) => round2(lista.reduce((s, c) => s + Number(c.valor || 0), 0))

  const pagar = abertas.filter((c) => c.tipo === 'pagar')
  const receber = abertas.filter((c) => c.tipo === 'receber')
  const atrasadasPagar = pagar.filter((c) => c.status_efetivo === 'atrasada')
  const atrasadasReceber = receber.filter((c) => c.status_efetivo === 'atrasada')

  // Mesma comparacao em calendario UTC de `statusEfetivo` — nao misturar hora
  // local com data pura aqui de novo, e exatamente o bug que acabou de ser
  // corrigido ali.
  const hojeUTC = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  const em7diasUTC = hojeUTC + 7 * 86400000
  // "Proximos 7 dias" e so o que ainda esta em dia — atrasada ja tem secao
  // propria e mais urgente; contar nas duas inflaria a soma visualmente.
  const proximos7dias = abertas.filter((c) => {
    if (c.status_efetivo !== 'pendente') return false
    const venc = new Date(c.vencimento)
    const vencUTC = Date.UTC(venc.getUTCFullYear(), venc.getUTCMonth(), venc.getUTCDate())
    return vencUTC <= em7diasUTC
  })

  return {
    a_pagar_total: soma(pagar),
    a_pagar_atrasado: soma(atrasadasPagar),
    a_pagar_atrasado_qtd: atrasadasPagar.length,
    a_receber_total: soma(receber),
    a_receber_atrasado: soma(atrasadasReceber),
    a_receber_atrasado_qtd: atrasadasReceber.length,
    proximos_7_dias_qtd: proximos7dias.length,
    proximos_7_dias_valor: soma(proximos7dias),
  }
}
