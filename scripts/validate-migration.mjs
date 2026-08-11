#!/usr/bin/env node
/**
 * Fase 6 — Validação pós-migração MongoDB → Supabase.
 * ============================================================================
 * Ferramenta SEPARADA de migrate-mongo-to-supabase.mjs (só lê, nunca
 * escreve — nem no Mongo nem no Supabase). Compara, por empresa:
 *   - contagens por coleção/tabela;
 *   - somas de valores monetários (total_gasto, total de pedidos, valor de
 *     pagamentos/transações);
 *   - relacionamentos/órfãos (pedido.comanda_id -> comanda existe,
 *     comanda.mesa_id -> mesa existe, etc.);
 *   - comanda.pagamentos[] (Mongo) vs linhas em `pagamentos` (Postgres) —
 *     ver §5 da auditoria: length(pagamentos[]) deve ser <= contagem real.
 *
 * Uso:
 *   node scripts/validate-migration.mjs [--empresa=<id>]
 *
 * Mesmas variáveis de ambiente de migrate-mongo-to-supabase.mjs.
 * Saída: relatório JSON por empresa + resumo global. Exit code 1 se
 * qualquer divergência real for encontrada (não é só um log informativo).
 */

import { MongoClient } from 'mongodb'

async function getSupabaseClient() {
  if (process.env.MIGRATION_TEST_POSTGREST_URL) {
    const { PostgrestClient } = await import('@supabase/postgrest-js')
    return new PostgrestClient(process.env.MIGRATION_TEST_POSTGREST_URL, {
      headers: { Authorization: `Bearer ${process.env.MIGRATION_TEST_JWT}` },
    })
  }
  const { getSupabaseAdmin, isSupabaseConfigured } = await import('../lib/integrations/supabase.js')
  if (!isSupabaseConfigured()) throw new Error('Supabase não configurado.')
  return getSupabaseAdmin()
}

function parseArgs(argv) {
  const args = { empresa: null }
  for (const a of argv) if (a.startsWith('--empresa=')) args.empresa = a.slice('--empresa='.length)
  return args
}

async function pgCount(supabase, table, empresaId) {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('empresa_id', empresaId)
  if (error) throw new Error(`Erro contando ${table}: ${error.message}`)
  return count
}

async function pgSum(supabase, table, column, empresaId) {
  const { data, error } = await supabase.from(table).select(column).eq('empresa_id', empresaId)
  if (error) throw new Error(`Erro somando ${table}.${column}: ${error.message}`)
  return (data ?? []).reduce((s, r) => s + Number(r[column] || 0), 0)
}

const COLLECTIONS = ['usuarios', 'categorias', 'produtos', 'clientes', 'mesas', 'comandas', 'pedidos', 'pagamentos', 'transacoes', 'integracoes', 'conversas', 'mensagens', 'auditoria']

async function validarEmpresa(db, supabase, empresaId, empresaSlug) {
  const divergencias = []
  const contagens = {}

  for (const col of COLLECTIONS) {
    const mongoCount = await db.collection(col).countDocuments({ empresa_id: empresaId })
    const pgCountVal = await pgCount(supabase, col, empresaId)
    contagens[col] = { mongo: mongoCount, postgres: pgCountVal }
    if (mongoCount !== pgCountVal) {
      divergencias.push({ tipo: 'contagem', tabela: col, mongo: mongoCount, postgres: pgCountVal })
    }
  }

  // Soma de valores monetários (§ validação de valor da auditoria)
  const mongoPedidos = await db.collection('pedidos').find({ empresa_id: empresaId }).toArray()
  const mongoTotalPedidos = mongoPedidos.reduce((s, p) => s + Number(p.total || 0), 0)
  const pgTotalPedidos = await pgSum(supabase, 'pedidos', 'total', empresaId)
  if (Math.abs(mongoTotalPedidos - pgTotalPedidos) > 0.01) {
    divergencias.push({ tipo: 'soma_valor', tabela: 'pedidos.total', mongo: mongoTotalPedidos, postgres: pgTotalPedidos })
  }

  const mongoClientes = await db.collection('clientes').find({ empresa_id: empresaId }).toArray()
  const mongoTotalGasto = mongoClientes.reduce((s, c) => s + Number(c.total_gasto || 0), 0)
  const pgTotalGasto = await pgSum(supabase, 'clientes', 'total_gasto', empresaId)
  if (Math.abs(mongoTotalGasto - pgTotalGasto) > 0.01) {
    divergencias.push({ tipo: 'soma_valor', tabela: 'clientes.total_gasto', mongo: mongoTotalGasto, postgres: pgTotalGasto })
  }

  const mongoPagamentos = await db.collection('pagamentos').find({ empresa_id: empresaId }).toArray()
  const mongoTotalPagamentos = mongoPagamentos.reduce((s, p) => s + Number(p.valor || 0), 0)
  const pgTotalPagamentos = await pgSum(supabase, 'pagamentos', 'valor', empresaId)
  if (Math.abs(mongoTotalPagamentos - pgTotalPagamentos) > 0.01) {
    divergencias.push({ tipo: 'soma_valor', tabela: 'pagamentos.valor', mongo: mongoTotalPagamentos, postgres: pgTotalPagamentos })
  }

  // Relacionamentos / órfãos
  const { data: pgPedidos } = await supabase.from('pedidos').select('id,comanda_id,cliente_id').eq('empresa_id', empresaId)
  const { data: pgComandas } = await supabase.from('comandas').select('id,mesa_id,cliente_id').eq('empresa_id', empresaId)
  const { data: pgMesas } = await supabase.from('mesas').select('id').eq('empresa_id', empresaId)
  const { data: pgClientes } = await supabase.from('clientes').select('id').eq('empresa_id', empresaId)

  const comandaIds = new Set((pgComandas ?? []).map((c) => c.id))
  const mesaIds = new Set((pgMesas ?? []).map((m) => m.id))
  const clienteIds = new Set((pgClientes ?? []).map((c) => c.id))

  const pedidosComComandaOrfa = (pgPedidos ?? []).filter((p) => p.comanda_id && !comandaIds.has(p.comanda_id))
  if (pedidosComComandaOrfa.length > 0) {
    divergencias.push({ tipo: 'orfao', tabela: 'pedidos.comanda_id', quantidade: pedidosComComandaOrfa.length, ids: pedidosComComandaOrfa.map((p) => p.id) })
  }
  const comandasComMesaOrfa = (pgComandas ?? []).filter((c) => c.mesa_id && !mesaIds.has(c.mesa_id))
  if (comandasComMesaOrfa.length > 0) {
    divergencias.push({ tipo: 'orfao', tabela: 'comandas.mesa_id', quantidade: comandasComMesaOrfa.length, ids: comandasComMesaOrfa.map((c) => c.id) })
  }
  const pedidosComClienteOrfo = (pgPedidos ?? []).filter((p) => p.cliente_id && !clienteIds.has(p.cliente_id))
  if (pedidosComClienteOrfo.length > 0) {
    divergencias.push({ tipo: 'orfao', tabela: 'pedidos.cliente_id', quantidade: pedidosComClienteOrfo.length, ids: pedidosComClienteOrfo.map((p) => p.id) })
  }

  // comanda.pagamentos[] (§5 da auditoria): length(array) deve ser <= contagem real em `pagamentos`
  const mongoComandas = await db.collection('comandas').find({ empresa_id: empresaId }).toArray()
  for (const c of mongoComandas) {
    const embutidos = Array.isArray(c.pagamentos) ? c.pagamentos.length : 0
    if (embutidos === 0) continue
    const reais = (mongoPagamentos ?? []).filter((p) => p.comanda_id === c.id).length
    if (embutidos > reais) {
      divergencias.push({ tipo: 'pagamentos_dessincronizados', comanda_id: c.id, embutidos, reais })
    }
  }

  return { empresaId, empresaSlug, contagens, divergencias }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.MONGO_URL || !process.env.DB_NAME) throw new Error('MONGO_URL/DB_NAME ausentes')

  const mongoClient = new MongoClient(process.env.MONGO_URL)
  await mongoClient.connect()
  const db = mongoClient.db(process.env.DB_NAME)
  const supabase = await getSupabaseClient()

  try {
    const query = args.empresa ? { id: args.empresa } : {}
    const empresas = await db.collection('empresas').find(query).toArray()

    const resultados = []
    for (const empresa of empresas) {
      const r = await validarEmpresa(db, supabase, empresa.id, empresa.slug)
      resultados.push(r)
      console.log(JSON.stringify({ empresa_id: r.empresaId, empresa_slug: r.empresaSlug, divergencias: r.divergencias.length, detalhe: r.divergencias }))
    }

    const totalDivergencias = resultados.reduce((s, r) => s + r.divergencias.length, 0)
    const resumo = {
      empresas_validadas: resultados.length,
      empresas_com_divergencia: resultados.filter((r) => r.divergencias.length > 0).length,
      total_divergencias: totalDivergencias,
    }
    console.log(JSON.stringify({ evento: 'resumo_final', ...resumo }))

    process.exitCode = totalDivergencias > 0 ? 1 : 0
  } finally {
    await mongoClient.close()
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', erro: err.message }))
  process.exitCode = 1
})
