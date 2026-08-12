/**
 * Mapeamento puro de Pedido/Comanda (contratos em packages/domain) para o
 * formato de dados que o componente de cupom consome. Sem JSX aqui de
 * proposito: mantem a transformacao de dados testavel isoladamente (Node
 * nao interpreta JSX sem um transpilador) e reutilizavel se um dia o cupom
 * ganhar outro formato de saida (ex.: texto puro para um agente local).
 */

/** Monta os dados de cupom a partir de um Pedido (contrato em domain.ts). */
export function dadosCupomPedido(pedido, empresa, via) {
  return {
    via,
    empresa,
    titulo: `Pedido #${pedido.numero}`,
    subtitulo: { balcao: 'Balcão', delivery: 'Delivery', retirada: 'Retirada', mesa: 'Mesa' }[pedido.tipo] || pedido.tipo,
    clienteNome: pedido.cliente_nome,
    itens: (pedido.itens || []).map((i) => ({ nome: i.nome, quantidade: i.quantidade, preco: i.preco, observacao: i.observacao })),
    subtotal: pedido.subtotal ?? pedido.total,
    desconto: pedido.desconto,
    acrescimo: pedido.acrescimo,
    total: pedido.total,
    pagamento: { pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' }[pedido.pagamento] || pedido.pagamento,
    observacoes: pedido.observacoes,
    criadoEm: pedido.created_at,
  }
}

/** Monta os dados de cupom a partir de uma Comanda (contrato em domain.ts). */
export function dadosCupomComanda(comanda, empresa, via) {
  return {
    via,
    empresa,
    titulo: comanda.mesa_nome,
    subtitulo: `${comanda.pessoas} pessoa${comanda.pessoas === 1 ? '' : 's'}`,
    clienteNome: comanda.cliente_nome,
    operadorNome: comanda.operador_nome,
    itens: (comanda.itens || []).map((i) => ({ nome: i.nome, quantidade: i.quantidade, preco: i.preco, observacao: i.observacao })),
    subtotal: comanda.subtotal,
    desconto: comanda.desconto_valor,
    acrescimo: comanda.taxa_valor,
    total: comanda.total,
    criadoEm: comanda.aberta_em,
  }
}
