# Auditoria — Fase 5 (Repositories Supabase)

Auditoria obrigatória antes de implementar, cruzando `packages/domain/src/index.ts`,
os 14 `lib/repositories/mongo/*.js`, os pontos reais de uso em
`app/api/[[...path]]/route.js`, as migrations `0001`-`0008` (Fase 4) e
`test_result.md`. Nenhum código de implementação foi escrito ainda neste
documento.

---

## 1. Inventário de repositories a implementar

14 arquivos Mongo existentes em `lib/repositories/mongo/`:
`empresaRepository, usuarioRepository, categoriaRepository,
produtoRepository, clienteRepository, transacaoRepository,
auditoriaRepository, integracaoRepository, mesaRepository,
comandaRepository, pagamentoRepository, conversaRepository,
mensagemRepository, pedidoRepository`.

**Mais 1 além dos 14**: `webhook_events` nunca teve um `Mongo*Repository`
próprio (decisão da Fase 3: é infra técnica, não entidade de domínio,
`route.js` acessa `db.collection('webhook_events')` direto). Para o lado
Supabase, crio um helper equivalente (`webhookEventsRepository.js`) mesmo
assim — não porque virou entidade de domínio, mas porque preservar
idempotência via `upsert` é exatamente o tipo de operação que fica mais
limpa isolada em um módulo pequeno, e o enunciado desta fase pede
explicitamente para tratar `webhook_events`. Fica fora de
`packages/domain/src/index.ts` (sem contrato formal), do mesmo jeito que a
versão Mongo está fora.

Total: **15 arquivos** em `lib/repositories/supabase/`.

---

## 2. Ferramenta de acesso e ambiente de teste

`lib/integrations/supabase.js` já expõe `getSupabaseAdmin()` — client
`@supabase/supabase-js` usando `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS,
igual ao service role do Postgres). Os repositories Supabase usam **esse
client** (recebido por injeção, mesmo padrão dos `Mongo*Repository` que
recebem `database` por parâmetro) — nunca instanciam Supabase sozinhos.

Para testar de verdade (não só ler o código e assumir), montei um ambiente
descartável, local, com os **mesmos binários oficiais que o Supabase usa em
produção**:
- `public.ecr.aws/supabase/postgres:17.6.1.158` — já usado na Fase 4.
- `public.ecr.aws/supabase/postgrest:v14.16` — camada REST real que o
  `supabase-js` fala por baixo dos panos (sem isso, testar os repositories
  seria só ler SQL cru via `psql`, que não exercita o código JS de verdade
  nem a serialização JSON/RLS via JWT).
- JWT `HS256` mintado localmente com `role: service_role` (mesmo mecanismo
  que `SUPABASE_SERVICE_ROLE_KEY` usa em produção — o `service_role` já
  tem `Bypass RLS` no Postgres do Supabase, confirmado na Fase 4).

Achado empírico importante (testado, não assumido): **colunas `numeric` e
`bigint` retornam como número JSON nativo** nesta versão do PostgREST
(`123.45`, não `"123.45"`), então não há necessidade de parsing
string→number ao ler de volta — o `supabase-js` já entrega `number`. Ainda
assim, os repositories fazem `Number(...)` **ao escrever** valores
monetários (defensivo, mesmo padrão já usado nos `Mongo*Repository`).

---

## 3. `config`/`payload` JSONB e snake_case

Toda a base de código (domain.ts, route.js, os 14 Mongo repositories) já
usa **snake_case consistentemente** em nomes de campo (`empresa_id`,
`cliente_nome`, `provider_payment_id` etc.) — não existe camelCase em
lugar nenhum do modelo de dados. **Não há mapeamento snake_case↔camelCase
a fazer**: os nomes de coluna do Postgres (Fase 4) já foram desenhados
para bater exatamente com os nomes de campo do Mongo/domain.ts. Campos
`jsonb` (`empresas.config`, `integracoes.config`, `webhook_events.payload`)
são objetos JS simples dos dois lados — `supabase-js` serializa/desserializa
automaticamente, sem tratamento especial.

---

## 4. Achado crítico #1 — `Pedido.itens` e `Comanda.itens` são embutidos no Mongo, tabelas separadas no Postgres

`domain.ts` declara `Pedido.itens: PedidoItem[]` e `Comanda.itens:
ComandaItem[]` como parte do próprio objeto da entidade — no Mongo isso é
um array embutido no documento; no Postgres (Fase 4) são as tabelas
`pedido_itens`/`comanda_itens`, referenciando o pai por FK.

**Consequência para os repositories**: para devolver um objeto que
satisfaça o mesmo contrato (`Pedido`/`Comanda` com `.itens` populado),
`SupabasePedidoRepository`/`SupabaseComandaRepository` precisam, em
`findById`/`list`, buscar as linhas filhas correspondentes e anexá-las
como `.itens` antes de devolver o objeto — e em `create`, separar o
`.itens` recebido em N inserções na tabela filha depois de inserir o pai.
Isso **não é regra de negócio** (não decide nada, só remonta a forma que o
Mongo já entregava naturalmente) — é exatamente o papel do Repository
Pattern: esconder o detalhe de armazenamento atrás do mesmo contrato.

---

## 5. Achado crítico #2 — `Comanda.pagamentos` existe no runtime real mas NÃO está em `domain.ts`

Lendo `route.js` de novo com atenção: `computeComanda(comanda)` (função do
**Service**, que NÃO pode ser alterada nesta fase) lê
`comanda.pagamentos` — um array embutido no Mongo com uma cópia
denormalizada de cada pagamento (`{id, metodo, valor, status, provider,
created_at}`) — para somar `pago = pagamentos.filter(status='approved').reduce(...)`.

**Esse campo nunca foi incluído na interface `Comanda` em
`packages/domain/src/index.ts`** — uma lacuna real da Fase 2, encontrada
só agora ao cruzar o código de verdade com o contrato formal. A Fase 4 já
tinha decidido (corretamente) **não duplicar** esse array como coluna no
Postgres — `pagamentos` vira tabela própria, fonte única.

**Conflito a resolver**: `computeComanda()` não pode ser alterado (regra
explícita desta fase), mas ele *depende* de `comanda.pagamentos` existir
no objeto em memória. Solução adotada (repository, não Service):
`SupabaseComandaRepository.findById`/`.list` fazem uma segunda consulta à
tabela `pagamentos` (só os campos equivalentes ao resumo antigo) e anexam
como `comanda.pagamentos` antes de devolver — reconstruindo, em memória,
exatamente a mesma forma que o Mongo sempre entregou. `pushPagamentoResumo()`
(método que no Mongo fazia `$push` nesse array) **vira no-op no Supabase**:
o dado já foi gravado por `pagamentoRepo.create()` (chamado antes, pelo
Service, na mesma rota) na tabela `pagamentos` — não há nada a mais para
gravar, só para o próximo `findById` já encontrar via a query anexada.

Corrijo também `domain.ts`: adiciono `pagamentos` como campo **documentado
como read-model denormalizado** na interface `Comanda` (não como写 write
model) para deixar essa realidade explícita — sem isso, o contrato mentia
sobre a forma real do objeto que circula em `route.js`.

---

## 6. Achado crítico #3 — colunas novas de `pedido_itens`/`comanda_itens` que o Service atual não popula

A Fase 4 criou `desconto`, `subtotal`, `observacao` (em `pedido_itens`) e
`desconto`, `subtotal` (em `comanda_itens`, que já tinha `observacao`)
como parte da decisão de snapshot histórico completo. **O Service atual
(`route.js`) nunca preenche `desconto` nem `subtotal` ao montar um item**
— nem para pedidos, nem para comandas.

**Decisão desta fase**: os repositories Supabase **não vão calcular**
`subtotal` (isso seria "cálculo de total" — regra de negócio, proibida
explicitamente no repository). Onde o Service não fornecer o campo, o
repository grava o default de schema (`desconto=0`, `subtotal=0`) e
**documenta isso como limitação conhecida**, não como bug — popular esses
campos de verdade exige alterar o Service para calcular e passar
`subtotal`/`desconto` por item, o que é trabalho de Fase 6 (quando o
Service for atualizado para orquestrar via repository de forma completa),
não desta fase.

---

## 7. Achado crítico #4 — `pedidoRepo.nextNumero()` teria duas fontes de atomicidade se implementado ingenuamente

O Service chama `pedidoRepo.nextNumero(empresaId)` **antes** de montar o
`doc` e chamar `create()` — em ambos os backends. No Postgres (Fase 4), a
tabela `pedidos` já tem uma trigger (`pedidos_set_numero()`) que
auto-atribui `numero` via o contador atômico `pedido_contadores` **se**
`numero` vier nulo no INSERT.

Se `SupabasePedidoRepository.nextNumero()` fizesse sua própria leitura
separada (ex.: um `select max(numero)`), reintroduziria exatamente a race
condition que a Fase 4 corrigiu. Solução: extraio a lógica de incremento
atômico da trigger para uma função SQL reutilizável
(`next_pedido_numero(empresa_id)`), a trigger passa a chamar essa função
(sem duplicar lógica), e `nextNumero()` no repository **chama a mesma
função via RPC** (`supabase.rpc('next_pedido_numero', {...})`). Resultado:
não importa se o Service usa o número devolvido por `nextNumero()`
explicitamente ou deixa a trigger assumir (`numero` nulo) — os dois
caminhos usam o **mesmo contador atômico único**, nunca duplicam.
Migration adicional necessária: `0009_repository_support_functions.sql`
(só extrai/expõe função existente + 2 funções novas de incremento
atômico, nenhuma regra de negócio, ver §8).

---

## 8. Achado crítico #5 — dois `$inc` atômicos do Mongo não têm equivalente direto em `supabase-js`

`clienteRepository.incrementarMetricasPedido` (`$inc:{total_pedidos:1,
total_gasto:valor}`) e `conversaRepository.incrementarNaoLidas`
(`$set:{...} + $inc:{nao_lidas:1}`) fazem incremento atômico no Mongo.
`supabase-js` não tem um `$inc` — só `.update({campo: valor})`, que exigiria
ler o valor atual antes (não atômico, condição de corrida real sob
concorrência, pior que o Mongo). **Não é uma regra de negócio decidir
"quanto" incrementar (isso o Service já decide e passa como parâmetro)** —
é só a mecânica de fazer a operação de forma atômica, equivalente a como a
numeração de pedidos já foi resolvida na Fase 4. Solução: 2 funções SQL
(`increment_cliente_metricas`, `increment_conversa_nao_lidas`), mesma
migration `0009`, chamadas via `.rpc()`.

---

## 9. Diferenças de mapeamento por entidade (resumo)

| Entidade | Diferença Mongo → Supabase | Tratamento no repository |
|---|---|---|
| Empresa | Nenhuma estrutural | 1:1 direto |
| Usuario | Nenhuma estrutural | 1:1 direto |
| Categoria | Nenhuma | 1:1 direto |
| Produto | Nenhuma | 1:1 direto |
| Cliente | `$inc` não atômico nativo | RPC `increment_cliente_metricas` |
| Transacao | Nenhuma estrutural | 1:1 direto |
| Auditoria | Nenhuma | 1:1 direto (append-only) |
| Integracao | Chave lógica (empresa_id,tipo), não id | upsert via `.upsert(...,{onConflict:'empresa_id,tipo'})` |
| Mesa | `syncStatusOcupada` precisa de filtro condicional | `.update().neq('status','livre')` — suportado nativamente |
| Pedido | `itens` embutido → tabela filha; numeração atômica | join em leitura, split em escrita, RPC `next_pedido_numero` |
| Comanda | `itens` embutido → tabela filha; `pagamentos` embutido não existe mais no schema mas é lido pelo Service | join em leitura (itens E pagamentos-resumo), split em escrita, `pushPagamentoResumo` vira no-op |
| Pagamento | Nenhuma estrutural | 1:1 direto |
| Conversa | `$inc` não atômico nativo | RPC `increment_conversa_nao_lidas` |
| Mensagem | Nenhuma | 1:1 direto (append-only) |
| webhook_events | Sem unique real no Mongo, unique real no Postgres | `.upsert(...,{onConflict:'event_key', ignoreDuplicates:true})` + checar se inseriu |

---

## 10. Erros — mapeamento

`supabase-js` devolve `{data, error}` (nunca lança exceção por erro de
constraint — precisa checar `error` explicitamente). Mapeamento adotado,
consistente em todos os repositories:

- **Erro de FK/constraint/CHECK** (`error.code` no padrão `23xxx` do
  Postgres — `23505` unique_violation, `23503` foreign_key_violation,
  `23514` check_violation): repropagado como `Error` JS normal com a
  mensagem original do Postgres anexada (`error.message`) — **nunca
  silenciado, nunca convertido em sucesso, nunca substituído por dado
  fictício**. Isso replica o comportamento que já existe hoje com Mongo
  (que também deixa exceções de driver subirem sem tratamento especial em
  nenhum `Mongo*Repository>`).
- **"Não encontrado" em `findById`/`findOne`-like**: usar `.maybeSingle()`
  do `supabase-js`, que devolve `data: null` sem erro quando zero linhas —
  equivalente exato ao `findOne()` do Mongo devolvendo `null`. Nunca usar
  `.single()` para esses casos (ele lança erro em zero linhas, diferente
  do Mongo).

---

## 11. Multi-tenancy

Confirmado, entidade por entidade, que **todo método tenant-scoped recebe
`empresaId` como parâmetro explícito** nos 14 `Mongo*Repository` — nenhuma
exceção. Os `Supabase*Repository` replicam a mesma assinatura de método
**exatamente** (mesmo nome, mesma ordem de parâmetros) para serem
intercambiáveis atrás do mesmo contrato, e todo `.from(tabela)` inclui
`.eq('empresa_id', empresaId)` explicitamente — **nunca dependendo só da
RLS** para o isolamento, conforme exigido.

---

## 12. `test_result.md` — o que precisa continuar batendo

Baseline a preservar (já confirmado idêntico em todas as fases
anteriores): **v1 40/40, v2 39/39, v3 32/33** (1 falha conhecida,
`tipo:'conversation'`, não é regressão). Esta fase não troca o runtime,
então esse número não deveria mudar — testado no final mesmo assim,
conforme pedido.

---

## 13. O que NÃO será feito nesta fase (confirmado contra o pedido)

- Nenhum switch `DATABASE_PROVIDER` global em `route.js`.
- Nenhuma migração de dados.
- Nenhuma remoção dos `Mongo*Repository`.
- Nenhuma alteração de `computeComanda()` ou de qualquer regra de negócio
  em `route.js`.
- Nenhuma alteração em `lib/integrations/{evolution,n8n}.js` ou no
  `PaymentProvider`.
- Nenhum mock de sucesso em nenhum cenário sem credencial.
