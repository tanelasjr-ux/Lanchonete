import assert from 'node:assert/strict'
import { computeCustoVenda, computeCMV } from './lib/custo.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('produto sem custo fica fora do calculo mas entra na base', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'a', preco: 30, quantidade: 1 }],
    custoPorProduto: { a: null },
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 0)
  assert.equal(r.receita_base, 30)
})

teste('custo zero e custo real e ENTRA no calculo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'brinde', preco: 12, quantidade: 1 }],
    custoPorProduto: { brinde: 0 },
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 12) // coberto, ao contrario do teste anterior
  assert.equal(r.receita_base, 12)
})

teste('mistura coberto e nao-coberto (exemplo da spec §6.1)', () => {
  const r = computeCustoVenda({
    itens: [
      { produto_id: 'a', preco: 20, quantidade: 1 },
      { produto_id: 'b', preco: 30, quantidade: 1 },
      { produto_id: 'c', preco: 10, quantidade: 1 },
    ],
    custoPorProduto: { a: 8, b: null, c: 4 },
  })
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_com_custo, 30)
  assert.equal(r.receita_base, 60)
})

teste('quantidade multiplica preco e custo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: 'a', preco: 10, quantidade: 3 }],
    custoPorProduto: { a: 4 },
  })
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_base, 30)
})

teste('rateio de comanda dividida soma exatamente o total', () => {
  const itens = [{ produto_id: 'a', preco: 100, quantidade: 1 }]
  const custoPorProduto = { a: 40 }
  // subtotal itens 100, taxa de servico 10%, total 110, pago 60 + 50
  const r1 = computeCustoVenda({ itens, custoPorProduto, rateio: 60 / 110 })
  const r2 = computeCustoVenda({ itens, custoPorProduto, rateio: 50 / 110 })
  assert.equal(r1.custo_total + r2.custo_total, 40)
  assert.equal(r1.receita_base + r2.receita_base, 100)
})

teste('item avulso sem produto_id fica fora do custo', () => {
  const r = computeCustoVenda({
    itens: [{ produto_id: null, preco: 25, quantidade: 1 }],
    custoPorProduto: {},
  })
  assert.equal(r.custo_total, 0)
  assert.equal(r.receita_com_custo, 0)
  assert.equal(r.receita_base, 25)
})

teste('rateio invalido nao produz NaN', () => {
  const itens = [{ produto_id: 'a', preco: 50, quantidade: 1 }]
  const custoPorProduto = { a: 20 }
  for (const rateio of [NaN, Infinity, undefined]) {
    const r = computeCustoVenda({ itens, custoPorProduto, rateio })
    assert.ok(Number.isFinite(r.custo_total), `custo_total nao finito para rateio ${rateio}`)
    assert.ok(Number.isFinite(r.receita_base), `receita_base nao finito para rateio ${rateio}`)
  }
})

teste('centavos nao acumulam erro de ponto flutuante', () => {
  const r = computeCustoVenda({
    itens: [
      { produto_id: 'a', preco: 0.1, quantidade: 1 },
      { produto_id: 'b', preco: 0.2, quantidade: 1 },
    ],
    custoPorProduto: { a: 0.05, b: 0.1 },
  })
  assert.equal(r.receita_base, 0.3)
  assert.equal(r.custo_total, 0.15)
})

teste('computeCMV agrega e calcula os tres indicadores', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 8, receita_com_custo: 20, receita_base: 50 },
    { tipo: 'receita', custo_total: 4, receita_com_custo: 10, receita_base: 10 },
  ])
  assert.equal(r.custo_total, 12)
  assert.equal(r.receita_com_custo, 30)
  assert.equal(r.receita_base, 60)
  assert.equal(r.cmv_percent, 40)
  assert.equal(r.cobertura_percent, 50)
  assert.equal(r.lucro_bruto, 18)
})

teste('computeCMV ignora despesa — estorno nao devolve custo', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 10, receita_com_custo: 40, receita_base: 40 },
    { tipo: 'despesa', categoria: 'Estorno', custo_total: 99, receita_com_custo: 99, receita_base: 99 },
  ])
  assert.equal(r.custo_total, 10)
  assert.equal(r.receita_com_custo, 40)
})

teste('indicadores sao null, nao zero, quando nao ha base', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 0, receita_com_custo: 0, receita_base: 80 },
  ])
  assert.equal(r.cmv_percent, null)
  assert.equal(r.lucro_bruto, null)
  assert.equal(r.cobertura_percent, 0) // ha base, cobertura e zero de verdade
})

teste('CMV acima de 100% quando o custo supera o preco', () => {
  const r = computeCMV([
    { tipo: 'receita', custo_total: 15, receita_com_custo: 10, receita_base: 10 },
  ])
  assert.equal(r.cmv_percent, 150)
  assert.equal(r.lucro_bruto, -5)
})

console.log(`\n${passou} testes passaram`)
