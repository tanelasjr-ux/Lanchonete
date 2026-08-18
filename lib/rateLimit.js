/**
 * Rate limiting em memoria, por chave (IP, ou IP+email).
 * ---------------------------------------------------------------------------
 * `/auth/login` sem limite = forca bruta de senha. `/auth/register` sem
 * limite = criacao ilimitada de tenants. Nenhum dos dois tinha protecao
 * nenhuma ate esta sessao (`docs/ANALISE-COMPETITIVA.md` §2.3).
 *
 * Em memoria porque o deploy hoje e UM UNICO processo Node
 * (`docker/Dockerfile`, sem replicas horizontais) — nao ha estado
 * compartilhado pra sincronizar. **Se o deploy um dia ganhar mais de uma
 * instancia, isto precisa migrar pra um armazem compartilhado** (Redis, ou
 * uma tabela no Postgres com TTL) — documentado aqui de proposito pra nao
 * virar bug silencioso (limite 3x mais permissivo que o pretendido, um por
 * instancia) quando essa mudanca acontecer.
 *
 * Janela fixa (fixed window), nao deslizante: mais simples de raciocinar
 * sobre, e a imprecisao de borda (rajada de ate 2x o limite bem na virada da
 * janela) e aceitavel aqui — o objetivo e frear automacao, nao contar com
 * precisao de auditoria.
 */

const janelas = new Map() // chave -> { contagem, expiraEm }

// Limpeza periodica pra nao vazar memoria com chaves que so aparecem uma
// vez (IP de visitante esporadico). Sob demanda, a cada N chamadas — nunca
// `setInterval`: isso seguraria o processo vivo mesmo sem requisicao
// nenhuma (relevante em teste/build) e exigiria limpeza manual no shutdown.
let chamadasDesdeLimpeza = 0
function limparExpirados() {
  chamadasDesdeLimpeza++
  if (chamadasDesdeLimpeza < 500) return
  chamadasDesdeLimpeza = 0
  const agora = Date.now()
  for (const [chave, valor] of janelas) {
    if (valor.expiraEm <= agora) janelas.delete(chave)
  }
}

/**
 * @param {string} chave identificador do limite (ex: `login:203.0.113.4:dono@x.com`)
 * @param {number} limite tentativas permitidas dentro da janela
 * @param {number} janelaMs duracao da janela, em milissegundos
 * @returns {{permitido: boolean, resetEm: number}}
 */
export function checarLimite(chave, limite, janelaMs) {
  // Escape hatch SO para desenvolvimento local — nunca setado em producao
  // (nao esta em nenhuma variavel do EasyPanel). Descoberto nesta sessao:
  // antivirus (Avast, `aswMonFltProxy`) injeta `X-Forwarded-For: 127.0.0.1`
  // em TODO trafego HTTP local, mesmo sem proxy real na frente e mesmo sem
  // o cliente mandar o header. Sem este escape, rodar a suite de testes
  // completa (15+ arquivos, nenhum deles ciente deste header novo) faria
  // todos compartilharem o balde de "127.0.0.1" e se bloquearem sozinhos —
  // exatamente o problema que `ipDoCliente() -> null` foi desenhado pra
  // evitar, so que por uma fonte de header diferente (AV local, nao um
  // fallback constante nosso). Mesmo padrao de escape ja usado no projeto
  // (`MIGRATE_DRY_RUN` em scripts/migrate.mjs).
  if (process.env.RATE_LIMIT_DISABLED === '1') return { permitido: true, resetEm: 0 }

  limparExpirados()
  const agora = Date.now()
  const atual = janelas.get(chave)

  if (!atual || atual.expiraEm <= agora) {
    janelas.set(chave, { contagem: 1, expiraEm: agora + janelaMs })
    return { permitido: true, resetEm: agora + janelaMs }
  }
  if (atual.contagem >= limite) {
    return { permitido: false, resetEm: atual.expiraEm }
  }
  atual.contagem++
  return { permitido: true, resetEm: atual.expiraEm }
}

/**
 * So para os testes conseguirem comecar cada caso do zero — nunca chamado
 * pelo app em runtime.
 */
export function _resetParaTeste() {
  janelas.clear()
  chamadasDesdeLimpeza = 0
}

/**
 * IP do cliente a partir dos headers de proxy reverso (EasyPanel roda atras
 * de Traefik). `X-Forwarded-For` pode ter uma cadeia `cliente, proxy1,
 * proxy2` — o primeiro endereco e o cliente original.
 *
 * Devolve `null` quando nenhum header esta presente, em vez de cair num
 * valor constante — um balde compartilhado por "todo mundo sem proxy"
 * juntaria QUALQUER requisicao sem esses headers (todo o ambiente de
 * desenvolvimento local, que nao roda atras de proxy nenhum) num unico
 * contador, e a propria suite de testes (centenas de `/auth/register` em
 * sequencia) estouraria o limite sozinha. Em producao, atras do Traefik do
 * EasyPanel, este header SEMPRE existe — `null` so acontece em dev/teste
 * direto, onde nao ha como identificar "um cliente" de verdade pra limitar.
 * O chamador (`route.js`) pula o rate limit quando o IP e `null`.
 */
export function ipDoCliente(request) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return null
}
