# Fase 7 — Switch de runtime (MongoDB ⇄ Supabase)

Implementação do switch de provider de persistência. A partir desta fase o
Restaurant OS roda **inteiro** sobre MongoDB ou sobre Supabase, escolhido por
uma única variável de ambiente, com **paridade de comportamento comprovada
pela suíte de regressão completa nos dois backends**.

## 1. O que mudou

### `lib/repositories/factory.js` (novo)

Ponto único que decide o backend. Lê `DATABASE_PROVIDER`:

| Valor | Efeito |
|---|---|
| `mongo` (**default**) | Comportamento histórico, inalterado |
| `supabase` | Usa os 15 `Supabase*Repository` (Fases 5/6B) |

Decisões embutidas:

- **Default é `mongo`**: ligar o Supabase é uma ação consciente. Voltar atrás
  é mudar a variável — sem redeploy de código, sem migration reversa.
- **Sem fallback silencioso**: `DATABASE_PROVIDER=supabase` sem credenciais
  **falha** em vez de cair para o Mongo. Um fallback silencioso significaria
  gravar dados no banco errado sem ninguém perceber.
- **Sem modo híbrido**: misturar backends na mesma requisição produziria
  leituras inconsistentes e quebraria as FKs do Postgres.
- **Valor inválido é erro explícito**, não default silencioso.

### `route.js` — não conhece mais nenhum driver de banco

Antes, além de construir os 14 repositories inline, acessava
`db.collection()` diretamente em 3 pontos fora do contrato. Todos eliminados:

| Acesso direto | Como ficou |
|---|---|
| `ensureIndexes()` | Movido para a factory. No Supabase é no-op — os índices vêm das migrations, versionadas |
| Bulk-insert do seed (8 `insertMany`) | `createMany()` nos repositories, implementado nos dois backends |
| `webhook_events` (dedupe) | `webhookEventsRepository` — o lado Supabase já existia (Fase 5), criado agora o lado Mongo |

`audit()` e `emitEvent()` passaram a receber `repos` em vez de `database`
(construíam repositories inline). `import { MongoClient }` foi removido.

### `/health` reporta o backend ativo

```json
{ "service": "restaurant-os", "status": "ok", "database": "mongo", "providers": { ... } }
```

`database` é o backend **realmente em uso**; `providers.supabase` continua
indicando apenas se há credenciais configuradas — que não implica que o
Supabase seja o runtime ativo.

### Contratos (`packages/domain/src/index.ts`)

Nova interface `BulkCreatable<T>`, aplicada a Categoria, Produto, Cliente,
Pedido, Transacao, Conversa, Mensagem e Integracao. `MesaRepository` manteve
seu `createMany` próprio: lá é feature de produto (`POST /mesas/configurar`
cria N mesas), não carga de seed.

## 2. Achados reais (encontrados rodando a suíte, não lendo código)

Ambos só aparecem sob **integridade referencial real** — no MongoDB passavam
despercebidos porque não há FK nem constraint equivalente.

### 2.1 Seed violava a FK `mesas_comanda_id_fkey`

O seed criava as 8 mesas já com `comanda_id` preenchido na mesa demo, e só
depois criava a comanda. No Postgres:

```
insert or update on table "mesas" violates foreign key constraint "mesas_comanda_id_fkey"
Key (comanda_id)=(...) is not present in table "comandas".
```

É a mesma dependência circular `mesas ⇄ comandas` que a ferramenta de
migração da Fase 6 já resolvia. **Corrigido com a mesma estratégia de duas
passadas**: mesa entra sem `comanda_id` → comanda é criada → a referência é
fechada com um `update`. Estado final idêntico nos dois backends.

### 2.2 Numeração de pedido colidia depois do seed

O seed insere pedidos em lote com `numero` explícito (1..N). Esse caminho não
passa pela trigger de numeração, então `pedido_contadores` ficava zerado — e o
primeiro pedido criado pela aplicação pedia `next_pedido_numero()`, recebia
`1` e colidia:

```
duplicate key value violates unique constraint "pedidos_empresa_id_numero_key"
Key (empresa_id, numero)=(..., 1) already exists.
```

No MongoDB não acontecia porque lá `nextNumero()` é `count()+1`, que já
enxerga os pedidos do seed.

**Corrigido** com `resync_pedido_contador_empresa()`
(`supabase/migrations/0014`), chamada pelo `createMany()` do
`SupabasePedidoRepository`. É a versão por-empresa do
`resync_pedido_contadores()` global que a Fase 6 já usava — o global varre
todas as empresas, caro demais para rodar a cada cadastro novo. Continua
**mecânica**: só alinha o contador ao maior número já gravado, não decide
valor de negócio.

## 3. Resultado da regressão

Mesma suíte, mesmos testes, os dois backends:

| Suíte | MongoDB | Supabase |
|---|---|---|
| `backend_test.py` (v1) | **40/40** | **40/40** |
| `backend_test_v2.py` (mesas/comandas/pagamentos) | **39/39** | **39/39** |
| `backend_test_v3.py` (atendimento/delivery) | **32/33** | **32/33** |

A única falha do v3 é idêntica nos dois lados e é o **não-bug já documentado**
(`test_result.md`): o webhook do WhatsApp grava `tipo: 'conversation'`, que é
o `messageType` real da Evolution API para texto simples — o teste é que
espera `'text'`.

Cobertura inclui isolamento multi-tenant (testes de Tenant A/B), regra
financeira de conclusão de pedido, fluxo completo de comandas e os caminhos
de integração não-configurada.

**Build de produção**: PASS. **Typecheck**: não disponível (o projeto não tem
`tsconfig`/`typescript` — `domain.ts` é contrato documental, não compilado).
**Lint**: não há script `lint` no `package.json`.

## 4. Como operar

```bash
# MongoDB (default — omitir a variável tem o mesmo efeito)
DATABASE_PROVIDER=mongo

# Supabase (exige SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
DATABASE_PROVIDER=supabase
```

Confirmar qual está ativo: `GET /api/health` → campo `database`.

Trocar exige reiniciar o processo (o Next.js dev recarrega `.env`
automaticamente; em produção, reiniciar o serviço).

## 5. O que esta fase NÃO fez

- **Não é o corte de produção.** A validação rodou contra o Supabase real,
  mas com os dados de desenvolvimento. Um corte real exige janela de
  manutenção e nova execução da migração contra o Mongo de produção
  (sempre `--dry-run` antes).
- **Não migrou o Auth.** Continua JWT local + scrypt. A migração para
  Supabase Auth segue pendente de auditoria própria.
- **Não ativou Realtime nem Storage.**
- **Os dois backends convivem.** Nada do lado MongoDB foi removido — é o
  caminho de rollback.
