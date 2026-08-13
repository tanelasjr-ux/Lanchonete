'use client'

/**
 * Impressao de cupom (comanda da cozinha / via do cliente).
 * ============================================================================
 * O sistema roda na nuvem; a impressora esta no restaurante. Nao ha caminho
 * de rede entre o servidor e a impressora — quem imprime e sempre o
 * navegador do caixa, usando `window.print()`. Impressora termica se
 * instala no sistema operacional como impressora comum: o navegador nao
 * precisa saber que ela e termica, so o layout precisa caber em 80mm.
 *
 * NAO E CUPOM FISCAL. E um comprovante de producao/atendimento — sem
 * validade tributaria. NFC-e/SAT exigem certificado digital e integracao
 * com a SEFAZ; ficou fora de escopo desta tarefa.
 *
 * Implementacao imperativa (`createRoot` num container proprio, fora da
 * arvore React do app) porque o app inteiro roda num unico componente com
 * estado local por tela (`Pedidos`, `Mesas` nao compartilham contexto) —
 * plugar isso via prop-drilling exigiria reestruturar varias telas so para
 * uma acao pontual de "imprimir". `imprimirCupom()` funciona a partir de
 * QUALQUER lugar do app sem precisar de contexto.
 */

import { createRoot } from 'react-dom/client'

const brl = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0))
const fmtDataHora = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

/**
 * @param {object} dados
 * @param {'cozinha'|'cliente'} dados.via — cozinha: sem precos/pagamento, so
 *   o que produzir. cliente: com valores, para o consumidor levar.
 * @param {{nome:string, endereco?:string, telefone?:string, logo?:string|null}} dados.empresa
 * @param {string} dados.titulo — ex.: "Pedido #12" ou "Mesa 03"
 * @param {string} [dados.subtitulo] — ex.: "Balcao" ou "3 pessoas"
 * @param {string} [dados.clienteNome]
 * @param {string} [dados.operadorNome]
 * @param {Array<{nome:string, quantidade:number, preco?:number, observacao?:string}>} dados.itens
 * @param {number} [dados.subtotal]
 * @param {number} [dados.desconto]
 * @param {number} [dados.acrescimo]
 * @param {number} [dados.entregaTaxa]
 * @param {number} [dados.total]
 * @param {string} [dados.pagamento]
 * @param {string} [dados.observacoes]
 * @param {string} [dados.tipo] — ex.: "delivery", "balcao", "retirada"
 * @param {string} [dados.entregaEndereco]
 * @param {string|Date} [dados.criadoEm]
 */
function CupomConteudo({ dados }) {
  const {
    via, empresa, titulo, subtitulo, clienteNome, operadorNome, itens = [],
    subtotal, desconto, acrescimo, entregaTaxa, total, pagamento, observacoes, criadoEm,
    tipo, entregaEndereco,
  } = dados
  const ehCliente = via === 'cliente'

  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        {ehCliente && empresa?.logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={empresa.logo} alt="" style={{ maxHeight: 48, maxWidth: '60%', margin: '0 auto 4px', display: 'block' }} />
        )}
        <div style={{ fontWeight: 700, fontSize: 14 }}>{empresa?.nome || 'Restaurante'}</div>
        {ehCliente && empresa?.endereco && <div>{empresa.endereco}</div>}
        {ehCliente && empresa?.telefone && <div>{empresa.telefone}</div>}
      </div>

      <div style={{ borderTop: '1px dashed #000', borderBottom: '1px dashed #000', padding: '4px 0', margin: '4px 0' }}>
        <div style={{ fontWeight: 700, fontSize: 14, textAlign: 'center' }}>
          {!ehCliente && 'COZINHA · '}{titulo}
        </div>
        {subtitulo && <div style={{ textAlign: 'center' }}>{subtitulo}</div>}
        {clienteNome && <div>Cliente: {clienteNome}</div>}
        {operadorNome && <div>Atendente: {operadorNome}</div>}
        {criadoEm && <div>{fmtDataHora(criadoEm)}</div>}
      </div>

      <div>
        {itens.map((it, i) => (
          <div key={i} className="cupom-item" style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{it.quantidade}x {it.nome}</span>
              {ehCliente && it.preco !== undefined && <span>{brl(it.preco * it.quantidade)}</span>}
            </div>
            {it.observacao && <div style={{ paddingLeft: 12, fontStyle: 'italic' }}>obs: {it.observacao}</div>}
          </div>
        ))}
        {itens.length === 0 && <div style={{ textAlign: 'center' }}>Sem itens</div>}
      </div>

      {ehCliente && (
        <div style={{ borderTop: '1px dashed #000', marginTop: 6, paddingTop: 4 }}>
          {subtotal !== undefined && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal</span><span>{brl(subtotal)}</span></div>}
          {Number(desconto) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Desconto</span><span>-{brl(desconto)}</span></div>}
          {Number(acrescimo) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Acrescimo</span><span>+{brl(acrescimo)}</span></div>}
          {tipo === 'delivery' && Number(entregaTaxa) > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Taxa Entrega</span><span>+{brl(entregaTaxa)}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 }}><span>TOTAL</span><span>{brl(total)}</span></div>
          {pagamento && <div style={{ marginTop: 4 }}>Pagamento: {pagamento}</div>}
        </div>
      )}

      {observacoes && (
        <div style={{ borderTop: '1px dashed #000', marginTop: 6, paddingTop: 4 }}>
          Obs: {observacoes}
        </div>
      )}

      {tipo === 'delivery' && entregaEndereco && (
        <div style={{ borderTop: '1px dashed #000', marginTop: 6, paddingTop: 4 }}>
          Endereço: {entregaEndereco}
        </div>
      )}

      {ehCliente && (
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 10 }}>
          Comprovante sem valor fiscal
        </div>
      )}
    </>
  )
}

/**
 * Imprime um cupom. Cria um container isolado no fim do `body`, renderiza o
 * conteudo, aciona `window.print()` e desmonta ao terminar — nao deixa
 * residuo na arvore do React nem no DOM depois de impresso/cancelado.
 *
 * O id `area-impressao` fica no CONTAINER (filho direto de `body`), nao num
 * elemento dentro do JSX renderizado — o CSS de impressao
 * (`body.imprimindo-cupom > *:not(#area-impressao)`) so consegue distinguir
 * "isto e o cupom" de "isto e o resto do app" olhando filhos diretos do
 * body. Um id equivalente um nivel mais fundo (dentro do container) faz o
 * proprio container cair no `:not(#area-impressao)` e ser escondido junto
 * com o cupom — foi exatamente o bug que produzia pagina em branco ao
 * imprimir (achado testando em producao, nao no dev local).
 */
export function imprimirCupom(dados) {
  const container = document.createElement('div')
  container.id = 'area-impressao'
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<CupomConteudo dados={dados} />)

  const limpar = () => {
    document.body.classList.remove('imprimindo-cupom')
    window.removeEventListener('afterprint', limpar)
    // Desmontar de imediato pode cortar a renderizacao em alguns navegadores
    // (Firefox dispara `afterprint` antes de finalizar o dialogo nativo).
    setTimeout(() => { root.unmount(); container.remove() }, 300)
  }
  window.addEventListener('afterprint', limpar)

  // Da um tick para o React montar o conteudo antes de imprimir.
  setTimeout(() => {
    document.body.classList.add('imprimindo-cupom')
    window.print()
  }, 50)
}
