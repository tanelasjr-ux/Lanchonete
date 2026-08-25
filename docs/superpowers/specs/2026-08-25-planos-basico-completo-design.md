# Planos Básico e Completo — Design

**Data:** 2026-08-25
**Pedido original:** o dono quer segmentar o Restaurant OS (ETNA) em dois planos comerciais, e pediu pesquisa de mercado antes de decidir o eixo de corte.

## Contexto e decisão de mercado

Pesquisa comparativa contra 6 concorrentes (Anota AI, Consumer, Saipos, Goomer, Toast POS, Square for Restaurants — publicada como artifact "Cardápio de Planos" e aprovada pelo dono) mostrou um padrão unânime: **nenhum concorrente relevante corta plano por canal de venda**. Mesa, balcão e delivery aparecem juntos até no plano gratuito ou mais barato de cada um deles. O eixo real que separa entrada de avançado no mercado inteiro é **profundidade de gestão** — estoque, caixa, KDS, relatórios financeiros, nota fiscal — nunca "onde o cliente pode comprar".

A proposta original do dono ("Básico = só mesa, Completo = mesa + delivery") foi descartada por dois motivos: (1) excluiria totalmente o segmento delivery-only (cozinha fantasma, sem salão físico) do plano de entrada; (2) tecnicamente, mesa/balcão/delivery hoje não são features separáveis — são só valores de `PedidoTipo` (`packages/domain/src/index.ts:29`), sempre disponíveis, sem nenhum toggle.

## Achado que muda a arquitetura: o campo já existe

`supabase/migrations/0027_assinaturas.sql:24` já declara `plano text not null default 'basico'` na tabela `assinaturas`. O campo é editável hoje pelo Painel ETNA (`app/page.js:4359`, um `<Input>` de texto livre) e aparece na tabela de empresas (`app/page.js:4641`), mas **nunca é lido por nenhuma lógica de gate** — é exatamente o mesmo padrão do bug que motivou a feature de módulos (B1): campo existe, ninguém consulta. Esta spec não cria nada novo de schema para o conceito de "plano" — só liga o fio que falta.

Segundo achado relevante: o comentário em `app/api/[[...path]]/route.js:1152-1154` (`PUT /modulos/:chave`, escrito numa sessão anterior, antes de qualquer trabalho de planos existir) já previa esta exata decisão: *"Enquanto não existe billing (B3), quem decide é o dono. Quando o plano passar a mandar, LIGAR vira decisão do plano e este handler passa a recusar o que o plano não cobre — desligar continua sendo do dono."* O design abaixo implementa exatamente essa intenção já registrada no código.

## Global Constraints

- Nunca tirar acesso de quem já usa um módulo (mesma disciplina do B1 — migration 0023). A Tanelas FooD (única empresa real em produção) já usa Estoque e Caixa ativamente hoje e nunca pode perder acesso no dia do deploy.
- `temModulo()` continua síncrona e com a mesma assinatura de função (`temModulo(empresa, modulo)`) — nenhuma das ~5 rotas que já a chamam (ou chamam `exigeModulo`) muda.
- Downgrade de plano nunca apaga dado — histórico de estoque/caixa/financeiro fica gravado e inacessível, nunca deletado.
- `empresa.plano` (campo legado top-level, `app/api/[[...path]]/route.js:719`, hoje hardcoded `'free'` no signup) é diferente de `assinaturas.plano` e **não deve ser tocado nem lido** por este trabalho — é o mesmo campo decorativo mencionado no comentário da migration 0027 como "texto livre que ninguém lê". A fonte de verdade é `assinaturas.plano`.

## 1. Modelo de dados

**Migration nova** (`supabase/migrations/00XX_planos_basico_completo.sql`), em uma única transação:

1. `alter table public.assinaturas add constraint assinaturas_plano_valido check (plano in ('basico', 'completo'));` — trava o texto livre num enum de 2 valores. Qualquer linha existente com `plano` fora desses dois valores quebraria a migration — não deve existir hoje (verificar antes de aplicar, já que o campo sempre foi digitado à mão via `<Input>` de texto livre).
2. Insere a assinatura da Tanelas FooD (`empresa_id` real, buscar por slug/nome em produção) com `plano = 'completo'`, `status = 'ativa'`, `valor` e `dia_vencimento`/`proximo_vencimento` provisórios (o dono ajusta o valor real depois pelo Painel, sem pressa — só o *plano* precisa estar certo no momento do deploy).
3. Atualiza `empresas.config` da Tanelas FooD para incluir `config.plano = 'completo'` (o espelho descrito na seção 2), na mesma migration — sem isso o gate barra o acesso dela no instante em que o código novo subir, antes de qualquer sincronização acontecer.

Testada em transação com `ROLLBACK` contra produção antes de aplicar, disciplina de sempre.

## 2. `empresa.config.plano` — o espelho

`empresa.config` ganha uma chave nova, `plano` (`'basico'` | `'completo'`), lida por `temModulo()`. É uma cópia de leitura de `assinaturas.plano` — a mesma família de padrão que `comanda.pago`/`restante` (campos cacheados, recalculados só quando algo muda, nunca a fonte de verdade).

**Sincronização:** toda vez que `PUT /plataforma/empresas/:id/assinatura` (`route.js:1316`) criar ou atualizar uma assinatura, grava também `empresa.config.plano = salva.plano` na mesma requisição (duas escritas, sem transação distribuída — aceitável porque a pior falha possível é a config ficar um passo atrás da assinatura até a próxima edição, nunca um estado inconsistente que vaze acesso: se a escrita em `empresas` falhar depois da escrita em `assinaturas` ter tido sucesso, o pior caso é o dono da empresa continuar vendo o plano antigo até a próxima sincronização manual — não é liberação indevida).

Empresa sem nenhuma assinatura (não deveria acontecer após esta mudança — ver seção 4 — mas cobrir o caso): `temModulo()` trata ausência de `config.plano` como `'basico'`, nunca como `'completo'` — mesma direção de segurança já usada para "ausência de flag = ligado", só que invertida aqui porque a falta de informação sobre PLANO deve negar o nível mais alto, não conceder.

## 3. `temModulo()` — a nova regra

`lib/modulos.js` ganha uma tabela declarando, por módulo, qual o plano mínimo que o inclui:

```js
export const PLANO_MODULOS = {
  basico: [],
  completo: ['estoque', 'caixa', 'financeiro'],
}
```

`MODULOS` ganha a entrada nova:

```js
financeiro: {
  label: 'Financeiro',
  descricao: 'DRE, comparativo de período, margem por canal/produto, contas a pagar e receber.',
  flags: ['financeiro'],
},
```

`temModulo(empresa, modulo)` passa a checar duas coisas, ambas precisando passar — mesmo espírito da dupla checagem já existente entre `can(papel)` e `temModulo(plano)`. A checagem de plano vira sua própria função exportada, `planoInclui()`, porque a seção 5 (`PUT /modulos/:chave`) precisa da MESMA regra isolada, sem a parte de flags — uma função só, nunca duas implementações da mesma decisão:

```js
/** O plano contratado permite este modulo? Modulos fora de PLANO_MODULOS
 *  (mesas, balcao, delivery, ...) nunca sao restringidos por plano. */
export function planoInclui(empresa, modulo) {
  const exigePlano = Object.values(PLANO_MODULOS).flat().includes(modulo)
  if (!exigePlano) return true
  const plano = empresa?.config?.plano || 'basico'
  return (PLANO_MODULOS[plano] || []).includes(modulo)
}

export function temModulo(empresa, modulo) {
  if (!planoInclui(empresa, modulo)) return false
  const flags = empresa?.config?.feature_flags
  if (!flags) return true
  return flags[modulo] !== false
}
```

`mesas` nunca entra em `PLANO_MODULOS` — continua sempre disponível em qualquer plano (a checagem de plano é pulada pra ele, `exigePlano` dá `false`), preservando o comportamento atual de "ausência de flag = ligado" para tudo que não é gateado por plano.

**`flagsPadraoSignup()`** não muda — continua ligando tudo por padrão nas *flags* (a segunda camada). É o *plano* que decide se a flag chega a ser consultada.

## 4. `POST /auth/register` — assinatura automática

Depois de criar `empresa` e `usuario` (`route.js:730-760`), o signup passa a também criar a assinatura:

```js
await assinaturaRepo.create({
  id: uuidv4(), empresa_id, plano: 'basico', valor: 0,
  dia_vencimento: 10, proximo_vencimento: <hoje + 30 dias>, status: 'ativa',
  ultimo_pagamento_em: null, observacoes: 'Criada automaticamente no cadastro — ajustar valor real.',
  created_at: new Date(), updated_at: new Date(),
})
```

E `empresa.config.plano = 'basico'` já nasce junto no objeto `config` do signup (`route.js:734`), sem precisar de uma segunda escrita.

Isso fecha o limbo atual (empresa nasce sem nenhuma linha em `assinaturas` até o dono da ETNA configurar manualmente) — toda empresa nova já tem uma assinatura formal desde o primeiro segundo, valor R$0 até o dono negociar e ajustar pelo Painel.

## 5. `PUT /modulos/:chave` — o teto

`route.js:1156-1169` ganha a checagem que o próprio comentário do handler já anunciava, reaproveitando `planoInclui()` da seção 3 (importada de `lib/modulos.js` junto de `MODULOS`/`temModulo`/`flagsPadraoSignup`, que o arquivo já importa hoje):

```js
if (b.ativo === true && !planoInclui(empresa, chave)) {
  return err(`Módulo "${mod.label}" não incluído no plano atual — fale com a ETNA para upgrade.`, 403)
}
```

Inserida logo após buscar `empresa` (antes de montar `config`/`flags`), **antes** de tocar em `feature_flags`. Desligar (`b.ativo === false`) nunca passa por essa checagem — o dono sempre pode desligar o que quiser, dentro ou fora do plano.

A variante para admin da plataforma (`route.js:1427`, mesma lógica mirando qualquer empresa) recebe a mesma trava — um admin da ETNA também não deveria conseguir ligar um módulo fora do plano contratado por engano; se precisar, muda o plano primeiro.

## 6. UI

**Painel ETNA** (`app/page.js:4359`): o `<Input>` de texto livre do campo `plano` vira um `<Select>` com as duas opções (`Básico` / `Completo`) — fecha o mesmo tipo de erro de digitação que motivou travar o campo no banco.

**Tela "Módulos" da empresa** (onde hoje o dono liga/desliga Estoque/Caixa): módulo fora do plano aparece com o toggle desabilitado e uma etiqueta "Disponível no plano Completo" em vez de simplesmente reagir com erro ao tentar ligar — mesmo padrão visual já usado pros módulos "Em breve".

## Fora do escopo desta spec

- Preço de cada plano — o campo `valor` da assinatura já é livre e editável por empresa individualmente hoje; esta spec não define uma tabela de preços fixa por plano.
- Cobrança automática, upgrade self-service pelo cliente, trial — nenhum desses foi pedido; troca de plano continua sendo o dono da ETNA operando pelo Painel.
- Folder de marketing e manual de configuração para o cliente — pedidos pelo dono para depois que a implementação técnica estiver no ar; não fazem parte deste plano de implementação técnico.
