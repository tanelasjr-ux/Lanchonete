import assert from 'node:assert/strict'
import { computeCaixaEsperado } from './lib/caixa.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('caixa sem movimento nenhum devolve o fundo de troco', () => {
  const r = computeCaixaEsperado({ valor_abertura: 100, transacoes: [], movimentos: [] })
  assert.equal(r.valor_esperado, 100)
})

teste('venda em dinheiro entra no esperado', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 50 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 150)
  assert.equal(r.receitas_dinheiro, 50)
})

teste('venda em pix e cartao NAO entra no esperado da gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'pix', valor: 80 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'cartao', valor: 70 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
  assert.equal(r.receitas_dinheiro, 0)
})

teste('sangria reduz e suprimento aumenta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [],
    movimentos: [
      { tipo: 'sangria', valor: 30 },
      { tipo: 'suprimento', valor: 20 },
    ],
  })
  assert.equal(r.valor_esperado, 90)
  assert.equal(r.sangrias, 30)
  assert.equal(r.suprimentos, 20)
})

teste('estorno em dinheiro reduz o esperado', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 50 },
      { tipo: 'despesa', categoria: 'Estorno', forma_pagamento: 'dinheiro', valor: 20 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 130)
  assert.equal(r.estornos_dinheiro, 20)
})

teste('estorno em pix NAO reduz o esperado da gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'despesa', categoria: 'Estorno', forma_pagamento: 'pix', valor: 20 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('despesa comum nao mexe na gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'despesa', categoria: 'Fornecedor', forma_pagamento: 'dinheiro', valor: 40 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('resumo por forma de pagamento soma todas as receitas', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 0,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 10 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 15 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'pix', valor: 40 },
    ],
    movimentos: [],
  })
  assert.equal(r.por_forma_pagamento.dinheiro, 25)
  assert.equal(r.por_forma_pagamento.pix, 40)
})

teste('transacao antiga sem forma_pagamento nao entra na gaveta', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 100,
    transacoes: [{ tipo: 'receita', categoria: 'Vendas', forma_pagamento: '', valor: 99 }],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 100)
})

teste('centavos nao acumulam erro de ponto flutuante', () => {
  const r = computeCaixaEsperado({
    valor_abertura: 0,
    transacoes: [
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 0.1 },
      { tipo: 'receita', categoria: 'Vendas', forma_pagamento: 'dinheiro', valor: 0.2 },
    ],
    movimentos: [],
  })
  assert.equal(r.valor_esperado, 0.3)
})

console.log(`\n${passou} testes passaram`)
