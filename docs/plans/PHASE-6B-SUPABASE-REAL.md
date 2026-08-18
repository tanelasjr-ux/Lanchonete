# Fase 6B — Validação contra projeto Supabase REAL (hospedado)

Fecha a última lacuna deixada pela Fase 6: até aqui, schema, repositories e
ferramenta de migração só tinham sido validados contra um Postgres+PostgREST
local em Docker — parecido com o Supabase, mas **sem o Kong** na frente do
PostgREST, sem o pooler de conexões e sem o comportamento real do gateway.
Esta fase reaplicou e revalidou tudo contra o projeto Supabase de verdade.

Runtime da aplicação **continua 100% MongoDB** — `route.js` não foi tocado.
Nenhum dado foi alterado ou apagado no MongoDB.

## 1. Estado inicial encontrado no projeto Supabase

O projeto **não estava vazio**: tinha 17 tabelas de uma versão anterior do
sistema (do protótipo inicial, antes da reescrita), num modelo genérico
`id / empresa_id / data jsonb / created_at` — cada registro era um blob JSON,
incompatível com o modelo relacional das Fases 4-6. Havia dados (3 empresas,
44 pedidos).

Decisão do dono do projeto: descartar o schema antigo (superado) e instalar o
atual. **Backup completo (`pg_dump` do schema `public`, com dados) foi feito
antes de qualquer DROP** e está em `backups/` (diretório adicionado ao
`.gitignore` — pode conter dados reais de clientes, não vai para o repo).

## 2. Aplicação do schema

Todas as 16 etapas aplicadas na ordem documentada no `README.md`
(`0001` → `triggers.sql` → `policies_rls.sql` → `seed.sql` → `0002`…`0013`),
sem nenhum erro. Resultado no banco real:

| Item | Resultado |
|---|---|
| Tabelas em `public` | 20 |
| Tabelas com RLS habilitado | 17 |
| Policies RLS | 18 |
| Funções (`public`) | 12 |
| Seed RBAC | 5 papéis, 30 permissões |
| Correções da Fase 6 presentes | `pedidos.comanda_id` ✔, `pedidos_tipo_check` com `'mesa'` ✔ |

**Nota de conectividade:** a *Direct connection* (`db.<ref>.supabase.co`)
resolve para IPv6 e ficou inacessível desta rede (`Network is unreachable`).
Usar o **Session Pooler** (`aws-0-us-east-2.pooler.supabase.com:5432`, IPv4)
para rodar migrations a partir daqui.

## 3. Achado real: bug que só apareceu contra o Supabase real

`increment_conversa_nao_lidas()` (migration `0009`) declarava os 5 parâmetros
como **obrigatórios e sem default**. Dois problemas:

1. `supabase-js` remove chaves `undefined` do corpo JSON. Um `patch` parcial
   (ex.: só `{ ultima_mensagem }`) chega ao PostgREST com 3 dos 5 parâmetros
   e **não casa com nenhuma assinatura** → `PGRST202
   "Could not find the function ... in the schema cache"`, um erro confuso e
   difícil de diagnosticar em produção.
2. Mesmo se casasse, o `UPDATE` sobrescreveria os campos omitidos com `NULL`
   — o que **não** é equivalente ao `$set` do Mongo (que só altera o que foi
   passado), e contradiz o contrato `patch: Partial<Conversa>` do `domain.ts`.

O fluxo atual do `route.js` sempre passa os 3 campos, então isso nunca
disparou — era uma armadilha esperando o primeiro caller parcial.

Corrigido em `supabase/migrations/0013_increment_conversa_patch_parcial.sql`:
defaults `null` + `coalesce(param, coluna)`, preservando o valor atual quando
o campo não é enviado. Continua mecânica (não decide valor de negócio).

## 4. Validação dos repositories contra o Supabase real

**39/39 testes passaram** usando `@supabase/supabase-js` `createClient()`
real (via Kong), não o `PostgrestClient` direto usado nos testes locais:

- Todos os 14 repositories exercitados (CRUD + métodos específicos:
  `findBySlug`, `findByEmail`, `findByTelefone`, `findByContatoNumero`,
  `listRecentes`, `findByCliente`, `count`, `upsert` por `empresa+tipo`).
- RPCs atômicas funcionando no ambiente real: `next_pedido_numero`,
  `increment_cliente_metricas`, `increment_conversa_nao_lidas`,
  `create_pedido_com_itens`, `create_comanda_com_itens`.
- Reconstrução de `comanda.pagamentos` a partir da tabela `pagamentos`
  (read-model denormalizado da Fase 5) — funcionando.
- Correção da Fase 6 (`pedido tipo='mesa'` com `comanda_id`) — funcionando.
- **6 testes de isolamento multi-tenant**: listagem, `findById` e `update`
  cross-tenant não vazam nem alteram dados de outra empresa.

## 5. Migração de dados para o Supabase real

| Etapa | Resultado |
|---|---|
| `--dry-run` (71 empresas) | Nenhuma escrita, contagens corretas |
| Migração real | 71/71 empresas, **0 erros**, exit code 0 |
| `validate-migration.mjs` | 71/71 empresas, **0 divergências** |

Contagens finais no Supabase real, batendo exatamente com o MongoDB:

```
empresas 71 | usuarios 71 | categorias 284 | produtos 781 | clientes 227
mesas 624 | comandas 113 | comanda_itens 227 | pedidos 1023
pedido_itens 1946 | pagamentos 28 | transacoes 761 | integracoes 213
conversas 156 | mensagens 383 | auditoria 688
```

## 6. Multi-tenancy confirmada no ambiente real

Requisito do produto (SaaS vendido para vários restaurantes): **um único
projeto Supabase atende todas as empresas** — não um projeto por cliente.
Verificado no banco real:

- 71 empresas convivendo no mesmo projeto, `71` `empresa_id` distintos em `pedidos`.
- **0 tabelas de domínio sem coluna `empresa_id`** (só os catálogos globais
  `papeis`/`permissoes` e a raiz `empresas` ficam de fora, por desenho).
- 17 tabelas com RLS + 18 policies ativas, além do isolamento na aplicação.
- **Evolution por empresa**: 71 linhas `integracoes` com `tipo='evolution'`
  (uma por empresa, `config` em JSONB) — a instância muda por empresa, o
  projeto Supabase é compartilhado. Mesmo padrão para `n8n` e `mercadopago`.

## 7. O que continua pendente

- **Fase 7 (troca de runtime)**: não iniciada. Preencher as variáveis
  Supabase no `.env` hoje não troca a persistência — a API continua usando
  os `Mongo*Repository`. Falta o switch de provider e rodar a suíte de
  regressão inteira contra `DATABASE_PROVIDER=supabase`.
- **Auth**: ainda JWT local; migração para Supabase Auth sem auditoria própria.
- **Corte de produção**: a migração de dados rodou contra o MongoDB de
  *desenvolvimento*. Um corte real precisa de janela de manutenção e nova
  execução contra o Mongo de produção.
