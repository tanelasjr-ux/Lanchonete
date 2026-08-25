import assert from 'node:assert/strict'
import { planoInclui, temModulo, PLANO_MODULOS, MODULOS } from './lib/modulos.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('financeiro entra no catalogo de modulos', () => {
  assert.ok(MODULOS.financeiro, 'MODULOS.financeiro precisa existir')
  assert.deepEqual(MODULOS.financeiro.flags, ['financeiro'])
})

teste('PLANO_MODULOS: basico nao inclui nada restrito, completo inclui estoque/caixa/financeiro', () => {
  assert.deepEqual(PLANO_MODULOS.basico, [])
  assert.deepEqual([...PLANO_MODULOS.completo].sort(), ['caixa', 'estoque', 'financeiro'].sort())
})

teste('planoInclui: modulo fora de PLANO_MODULOS nunca e restringido (mesas)', () => {
  assert.equal(planoInclui({ config: { plano: 'basico' } }, 'mesas'), true)
  assert.equal(planoInclui({ config: {} }, 'mesas'), true)
})

teste('planoInclui: empresa basico NAO inclui estoque/caixa/financeiro', () => {
  const empresa = { config: { plano: 'basico' } }
  assert.equal(planoInclui(empresa, 'estoque'), false)
  assert.equal(planoInclui(empresa, 'caixa'), false)
  assert.equal(planoInclui(empresa, 'financeiro'), false)
})

teste('planoInclui: empresa completo inclui estoque/caixa/financeiro', () => {
  const empresa = { config: { plano: 'completo' } }
  assert.equal(planoInclui(empresa, 'estoque'), true)
  assert.equal(planoInclui(empresa, 'caixa'), true)
  assert.equal(planoInclui(empresa, 'financeiro'), true)
})

teste('planoInclui: config.plano ausente conta como basico (nunca completo por omissao)', () => {
  assert.equal(planoInclui({ config: {} }, 'estoque'), false)
  assert.equal(planoInclui({}, 'estoque'), false)
})

teste('temModulo: plano basico bloqueia estoque mesmo com a flag ligada', () => {
  const empresa = { config: { plano: 'basico', feature_flags: { estoque: true } } }
  assert.equal(temModulo(empresa, 'estoque'), false, 'plano deve vencer antes da flag ser consultada')
})

teste('temModulo: plano completo + flag desligada continua bloqueado (as duas camadas valem)', () => {
  const empresa = { config: { plano: 'completo', feature_flags: { estoque: false } } }
  assert.equal(temModulo(empresa, 'estoque'), false)
})

teste('temModulo: plano completo + flag ligada libera', () => {
  const empresa = { config: { plano: 'completo', feature_flags: { estoque: true } } }
  assert.equal(temModulo(empresa, 'estoque'), true)
})

teste('temModulo: mesas continua imune a plano, so a flag decide', () => {
  assert.equal(temModulo({ config: { plano: 'basico', feature_flags: { mesas: true } } }, 'mesas'), true)
  assert.equal(temModulo({ config: { plano: 'basico', feature_flags: { mesas: false } } }, 'mesas'), false)
})

teste('planoInclui: nomes de propriedade especiais do JS nunca vazam acesso nem quebram', () => {
  for (const plano of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(planoInclui({ config: { plano } }, 'estoque'), false, `plano='${plano}' deveria negar, nunca lancar excecao`)
  }
})

teste('planoInclui/temModulo: empresa totalmente null ou modulo desconhecido nao quebram', () => {
  assert.equal(planoInclui(null, 'estoque'), false)
  assert.equal(temModulo(null, 'estoque'), false)
  assert.equal(planoInclui({ config: { plano: 'completo' } }, 'modulo_que_nao_existe'), true, 'modulo fora do catalogo nunca e restringido por plano')
})

console.log(`\n${passou}/12 testes passaram`)
if (passou < 12) process.exit(1)
