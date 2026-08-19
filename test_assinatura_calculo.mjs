import assert from 'node:assert/strict'
import { diasDeAtraso, statusEfetivo, avisoParaCliente, resumoCarteira } from './lib/assinatura.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

const hoje = (ymd) => new Date(`${ymd}T12:00:00Z`)

teste('diasDeAtraso: vence hoje e 0, nao negativo', () => {
  assert.equal(diasDeAtraso('2026-08-18', hoje('2026-08-18')), 0)
})

teste('diasDeAtraso: vence no futuro fica clampado em 0', () => {
  assert.equal(diasDeAtraso('2026-08-25', hoje('2026-08-18')), 0)
})

teste('diasDeAtraso: conta dias corridos apos o vencimento', () => {
  assert.equal(diasDeAtraso('2026-08-10', hoje('2026-08-18')), 8)
})

teste('diasDeAtraso: nao quebra na virada de mes/ano', () => {
  assert.equal(diasDeAtraso('2025-12-30', hoje('2026-01-02')), 3)
})

teste('statusEfetivo: cancelada nunca vira atrasada', () => {
  assert.equal(statusEfetivo({ status: 'cancelada', proximo_vencimento: '2020-01-01' }, hoje('2026-08-18')), 'cancelada')
})

teste('statusEfetivo: ativa em dia continua ativa', () => {
  assert.equal(statusEfetivo({ status: 'ativa', proximo_vencimento: '2026-08-20' }, hoje('2026-08-18')), 'ativa')
})

teste('statusEfetivo: ativa vencida vira atrasada so na leitura', () => {
  assert.equal(statusEfetivo({ status: 'ativa', proximo_vencimento: '2026-08-10' }, hoje('2026-08-18')), 'atrasada')
})

teste('avisoParaCliente: nada a avisar antes do vencimento (sem aviso antecipado)', () => {
  assert.equal(avisoParaCliente({ status: 'ativa', proximo_vencimento: '2026-08-25' }, hoje('2026-08-18')), null)
})

teste('avisoParaCliente: nada a avisar no proprio dia do vencimento', () => {
  assert.equal(avisoParaCliente({ status: 'ativa', proximo_vencimento: '2026-08-18' }, hoje('2026-08-18')), null)
})

teste('avisoParaCliente: cancelada nunca gera aviso', () => {
  assert.equal(avisoParaCliente({ status: 'cancelada', proximo_vencimento: '2020-01-01' }, hoje('2026-08-18')), null)
})

teste('avisoParaCliente: 1 a 3 dias de atraso e faixa amber', () => {
  const a = avisoParaCliente({ status: 'ativa', proximo_vencimento: '2026-08-16' }, hoje('2026-08-18'))
  assert.equal(a.nivel, 'amber')
  assert.equal(a.dias, 2)
})

teste('avisoParaCliente: 4+ dias de atraso e faixa vermelha', () => {
  const a = avisoParaCliente({ status: 'ativa', proximo_vencimento: '2026-08-10' }, hoje('2026-08-18'))
  assert.equal(a.nivel, 'vermelho')
  assert.equal(a.dias, 8)
  assert.ok(a.mensagem.includes('8 dias'))
})

teste('resumoCarteira: MRR conta ativas e atrasadas, nao so em dia', () => {
  const r = resumoCarteira([
    { status_efetivo: 'ativa', valor: 100 },
    { status_efetivo: 'atrasada', valor: 50 },
    { status_efetivo: 'cancelada', valor: 200 },
  ])
  assert.equal(r.ativas_qtd, 1)
  assert.equal(r.atrasadas_qtd, 1)
  assert.equal(r.atrasadas_valor, 50)
  assert.equal(r.ativas_mrr, 150) // ativas + atrasadas, cancelada fora
})

teste('resumoCarteira: lista vazia nao quebra', () => {
  const r = resumoCarteira([])
  assert.deepEqual(r, { ativas_qtd: 0, ativas_mrr: 0, atrasadas_qtd: 0, atrasadas_valor: 0 })
})

console.log(`\n${passou} testes passaram`)
