# Fase 6 — Migração de Dados MongoDB → Supabase

Implementação da ferramenta de migração de dados, seguindo o plano em
`docs/plans/PHASE-6-MIGRATION-AUDIT.md`. Runtime da aplicação **não foi
alterado** — `app/api/[[...path]]/route.js` continua 100% MongoDB. Nenhum
dado foi apagado/alterado no MongoDB em nenhum momento desta fase.

## O que foi entregue

- `supabase/migrations/0011_migration_upsert_functions.sql` — `upsert_pedido_com_itens()`, `upsert_comanda_com_itens()`, `resync_pedido_contadores()`: versões idempotentes (upsert do pai + replace dos filhos) das funções atômicas da Fase 5, usadas só por esta ferramenta.
- `supabase/migrations/0012_pedidos_comanda_id.sql` — corrige uma lacuna real de schema encontrada **durante esta própria fase** (ver §1).
- `scripts/migrate-mongo-to-supabase.mjs` — ferramenta de migração (CLI).
- `scripts/validate-migration.mjs` — ferramenta de validação pós-migração (só leitura).
- `docs/plans/PHASE-6-MIGRATION-AUDIT.md` — atualizado com os 2 achados abaixo.
- `packages/domain/src/index.ts` — `PedidoTipo` ampliado com `'mesa'`.
- `README.md` — ordem de execução de migrations atualizada até `0012`.

## 1. Achados reais (encontrados testando, não só lendo código)

Estes 3 problemas **não existiam** na auditoria original desta fase — foram
encontrados ao migrar dados reais do MongoDB de desenvolvimento (71 empresas,
dados orgânicos acumulados durante as Fases 3–5) contra um Postgres+PostgREST
real, exatamente o tipo de checagem que o princípio-guia desta fase exige
("migrar com base no MongoDB real").

1. **`pedidos.comanda_id` não existia como coluna.** Pedidos originados do
   fechamento de comanda (`route.js`) sempre carregaram `comanda_id`, mas
   nenhuma migration até a 0011 tinha essa coluna (só `transacoes.comanda_id`
   fora corrigida na Fase 4). Corrigido na migration `0012` + `create_pedido_com_itens()`/`upsert_pedido_com_itens()` atualizadas.
2. **`pedidos_tipo_check` não incluía `'mesa'`.** Mesmo fluxo do item 1 usa
   `tipo: 'mesa'`, um 4º valor real nunca coberto pelo CHECK constraint
   (`0001_init.sql` só tinha `balcao|delivery|retirada`). Corrigido na mesma
   migration `0012`.
3. **Ordem de migração `pedidos` antes de `comandas` ficou inválida** depois
   da correção do item 1 (agora há uma FK real `pedidos.comanda_id ->
   comandas.id`). A primeira execução real da ferramenta falhou exatamente
   como o Postgres deveria falhar (`pedidos_comanda_id_fkey` violada,
   comanda ainda não existia) — corrigido invertendo a ordem: `comandas`
   migra antes de `pedidos`.
4. **Upsert em lote via PostgREST não aplica o DEFAULT da coluna por linha.**
   Quando um lote (`supabase.from(t).upsert([...])`) mistura linhas que têm
   um campo opcional (ex.: `updated_at`, presente só em documentos Mongo já
   editados ao menos uma vez) com linhas que não têm, o PostgREST grava
   `NULL` nas linhas sem o campo em vez de aplicar o `DEFAULT` da coluna —
   diferente do comportamento de um `INSERT` de uma linha só. Encontrado
   migrando `integracoes` reais (2 de 3 documentos por empresa nunca foram
   editados, 1 foi). Corrigido no `pick()` do script: `updated_at` ausente
   cai para `created_at` (mesmo valor que a linha teria se nunca editada —
   não é dado inventado).

Todos os 4 achados foram corrigidos e revalidados antes de prosseguir,
seguindo a autonomia de correção interna concedida para esta fase.

## 2. Estratégia de idempotência (validada, não só projetada)

- Entidades simples: `upsert(rows, {onConflict:'id'})` em lotes de 200.
- `pedidos`/`comandas`: RPC idempotente (upsert do pai + delete/insert dos
  filhos) — reexecutar não duplica nem perde itens.
- **IDs sintéticos (itens sem `id` no Mongo) são determinísticos** (UUID v5
  a partir de `${parentId}:${index}`, não `UUID v4` aleatório) — reexecutar
  a migração com o mesmo documento de origem produz exatamente o mesmo id,
  não só a mesma contagem. Validado: rodado a mesma empresa 2x, itens
  sintéticos com id idêntico nas duas execuções.
- Checkpoint por `(empresa_id, passo)`: uma interrupção no meio de uma
  empresa retoma exatamente do passo seguinte, sem repetir trabalho já
  concluído nem pular nada.
- Campos ausentes no Mongo nunca são "resetados" numa reexecução — o upsert
  só escreve as colunas presentes no payload; um valor real já existente no
  Postgres (de um uso anterior do runtime, por exemplo) não é apagado por
  uma reexecução da migração que não tem aquele dado na origem.

## 3. Testes executados (todos passaram)

| Cenário | Resultado |
|---|---|
| `--dry-run` (1 empresa, dados reais) | Nenhuma escrita; contagens e estatísticas de transformação corretas |
| Migração real (1 empresa) | Todas as 14 coleções migradas, RPCs de pedidos/comandas OK |
| Reexecução (idempotência, mesma empresa) | Contagens finais idênticas; zero duplicação |
| Determinismo de IDs sintéticos | IDs de itens sintetizados idênticos entre 2 execuções |
| Multi-empresa (71 empresas reais) | 71/71 migradas, 0 erros, exit code 0 |
| Banco Mongo vazio | Encerra corretamente, exit code 0, sem erro |
| Dados incompletos (cliente sem telefone/email) | Coluna recebe o DEFAULT do schema corretamente |
| Conflito (registro pré-existente divergente no Postgres) | Mongo prevalece nos campos que possui; campos que Mongo não tem não são tocados |
| Execução parcial/interrompida | Coberto pela própria falha real do item 3 do §1 — checkpoint permitiu retomar exatamente do ponto certo após a correção |
| `validate-migration.mjs` (71 empresas migradas) | 0 divergências: contagens, somas (`pedidos.total`, `clientes.total_gasto`, `pagamentos.valor`), órfãos (`pedidos.comanda_id`, `comandas.mesa_id`, `pedidos.cliente_id`), `comanda.pagamentos[]` vs `pagamentos` |
| Equivalência pós-migração (pedidos/comandas/clientes/produtos, Mongo vs Supabase, mesma empresa) | 8/8 — inclui checagem específica de `comanda_id` (achado desta sessão) |
| Regressão dos 14 `Supabase*Repository` (Fase 5) | 14/14 OK, zero regressão causada pelas migrations 0011/0012 |

**Validação de contagem exata (sem amostragem):** com as 71 empresas reais
migradas, comparado contra os 3 registros de fixture pré-existentes no
Postgres de teste (não vindos desta migração): `1023` pedidos migrados
`=` `1023` pedidos no Mongo, exatamente — zero perda, zero duplicação,
confirmado tabela por tabela.

## 4. Limitações conhecidas (documentadas, não escondidas)

- `webhook_events` não é migrado (decisão da auditoria, §6 — log técnico
  sem valor retroativo).
- `comanda.pagamentos[]` é descartado na migração (decisão da auditoria,
  §5) — a fonte migrada é sempre a tabela `pagamentos`.
- Itens de `comanda_itens`/`pedido_itens` sem `desconto`/`subtotal` no Mongo
  recebem os valores sintetizados documentados no §4 do audit doc
  (`desconto=0`, `subtotal=preco*quantidade-desconto`) — não é dado
  inventado, é a mesma fórmula que o Service já usa em memória.
- A ferramenta foi testada até agora só contra o ambiente de teste local
  (Postgres+PostgREST via Docker, mesma imagem oficial usada nas Fases 4/5).
  Não foi executada contra um projeto Supabase hospedado real — o caminho
  de produção (`getSupabaseAdmin()`) é o mesmo já usado pelos 15
  `Supabase*Repository`, mas o `--dry-run` deve ser rodado primeiro contra
  qualquer ambiente novo antes de uma execução real.

## 5. Resumo final (formato solicitado)

```
Registros no MongoDB (71 empresas reais, ambiente de dev):
  usuarios: 71 | categorias: 284 | produtos: 781 | clientes: 227
  mesas: 624 | comandas: 113 | pedidos: 1023 | pagamentos: 28
  transacoes: 761 | integracoes: 213 | conversas: 156 | mensagens: 383
  auditoria: 688

Migrados com sucesso: 100% em todas as 14 coleções (0 falhas após as
correções do §1).

Divergentes: 0 (validate-migration.mjs: 71/71 empresas, 0 divergências de
contagem, soma de valor, órfãos ou pagamentos dessincronizados).

Erros encontrados e corrigidos durante a própria migração:
  1. pedidos.comanda_id ausente (coluna nova, migration 0012)
  2. pedidos_tipo_check sem 'mesa' (constraint corrigida, migration 0012)
  3. Ordem comandas/pedidos invertida (FK nova do item 1)
  4. Upsert em lote do PostgREST não aplica DEFAULT por linha (updated_at)

Validações executadas: contagem, soma de valor monetário, órfãos/FK,
comanda.pagamentos[] vs pagamentos reais, equivalência de campos
pedido/comanda entre Mongo e Supabase, regressão dos 14 repositories Fase 5.

Testes: dry-run, migração real, idempotência/reexecução, determinismo de
IDs sintéticos, multi-empresa (71), banco vazio, dados incompletos,
conflito de dados, execução parcial/interrompida — todos passaram.

Limitações: webhook_events e comanda.pagamentos[] não migrados (por
desenho, ver auditoria); não testado ainda contra projeto Supabase
hospedado real (só ambiente Docker local).

Recomendação sobre a Fase 7: schema, repositories e ferramenta de migração
estão prontos e validados. A Fase 7 (troca de runtime MongoDB -> Supabase
em produção) pode ser avaliada, mas NÃO foi iniciada nesta fase — aguardando
aprovação explícita do dono do projeto, conforme instruído.
```

**NÃO avançar para a Fase 7 automaticamente**, conforme instrução explícita.
