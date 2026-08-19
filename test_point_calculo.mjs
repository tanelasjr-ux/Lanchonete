import assert from 'node:assert/strict'
import { normalizeStatus, formatarValorParaOrder, montarExternalReference } from './lib/integrations/payments/point.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('normalizeStatus: processed vira approved', () => {
  assert.equal(normalizeStatus('processed'), 'approved')
})

teste('normalizeStatus: created e at_terminal viram pending', () => {
  assert.equal(normalizeStatus('created'), 'pending')
  assert.equal(normalizeStatus('at_terminal'), 'pending')
})

teste('normalizeStatus: expired e canceled viram cancelled', () => {
  assert.equal(normalizeStatus('expired'), 'cancelled')
  assert.equal(normalizeStatus('canceled'), 'cancelled')
})

teste('normalizeStatus: estado desconhecido nunca quebra, vira unknown', () => {
  assert.equal(normalizeStatus('algo_que_nao_existe_ainda'), 'unknown')
})

teste('formatarValorParaOrder: sempre 2 casas, nunca centavos (o erro classico)', () => {
  assert.equal(formatarValorParaOrder(50), '50.00')
  assert.equal(formatarValorParaOrder(24.5), '24.50')
  assert.equal(formatarValorParaOrder(19.999), '20.00')
})

teste('montarExternalReference: formato empresa:tipo:id', () => {
  assert.equal(montarExternalReference('emp1', 'comanda', 'cmd1'), 'emp1:comanda:cmd1')
  assert.equal(montarExternalReference('emp1', 'pedido', 'ped1'), 'emp1:pedido:ped1')
})

console.log(`\n${passou} testes passaram`)
