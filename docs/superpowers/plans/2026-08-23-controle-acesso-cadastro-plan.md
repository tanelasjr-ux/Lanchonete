# Controle de Acesso ao Cadastro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** so o dono da ETNA pode liberar quais e-mails conseguem completar
o cadastro de uma empresa nova — `POST /auth/register` passa a exigir que
o e-mail esteja numa allowlist gerenciada pelo Painel ETNA.

**Architecture:** uma tabela nova (`emails_liberados`), sem escopo de
tenant, no mesmo espirito de `plataforma_admins` (migration 0027) — dono
libera o e-mail antes; o gate em `POST /auth/register` consulta essa tabela
e bloqueia com 403 se o e-mail nao estiver la; ao completar o cadastro com
sucesso, o e-mail e marcado como usado. Gerenciado pelo Painel ETNA, exposto
via 3 rotas novas sob `/plataforma/*` (mesmo padrao de autorizacao das
rotas de assinatura ja existentes). Login de contas existentes nao muda.

**Tech Stack:** Next.js API routes (`app/api/[[...path]]/route.js`), Mongo
e Supabase via Repository Pattern, React (`app/page.js`), Python/pytest
para os testes de integracao.

**Spec:** `docs/superpowers/specs/2026-08-19-controle-acesso-cadastro-design.md`

## Global Constraints

- **Nunca simular sucesso.** Sem e-mail liberado, `POST /auth/register`
  falha com 403 e mensagem clara — nunca cria a empresa mesmo assim.
- **`SIGNUP_ALLOWLIST_DISABLED=1` desliga o gate.** Mesmo padrao ja usado
  para `RATE_LIMIT_DISABLED` neste projeto — nunca setada em producao,
  sempre setada ao rodar a suite local (17 suites de teste registram
  empresas o tempo todo e quebrariam sem isso).
- **E-mail normalizado com `toLowerCase().trim()`** em toda leitura/escrita
  desta feature — mesmo normalizador que `/auth/register` ja usa, para
  nunca cadastrar "Joao@X.com" na allowlist e falhar bater com
  "joao@x.com" no cadastro real.
- **`emails_liberados` nao tem `empresa_id`** — e infraestrutura da
  PLATAFORMA (a ETNA), igual a `plataforma_admins`. Nenhuma rota desta
  feature usa `can(ctx.papel, ...)`; todas usam `exigePlataformaAdmin()`.
- **Toda rota nova sob `/plataforma/emails-liberados` protegida por
  `exigePlataformaAdmin()`** — a mesma funcao que ja protege
  `/plataforma/empresas` e `/plataforma/assinaturas/*`.
- **Toda tabela/repositorio novo segue a assinatura ja usada no resto do
  codigo:** `create(entity)` recebe a ENTIDADE COMPLETA (com `id` e
  `created_at` ja preenchidos pelo chamador) — nunca `Omit<...>`. Confirmado
  contra `AssinaturaRepository`/`ContaRepository`/`Repository<T>` no
  contrato de dominio: **nenhum** repositorio deste projeto gera `id`
  sozinho.

---

## Mapa de arquivos

| Arquivo | Mudanca |
|---|---|
| `supabase/migrations/0030_emails_liberados.sql` | cria (tabela) |
| `packages/domain/src/index.ts` | modifica (2 interfaces) |
| `lib/repositories/mongo/emailLiberadoRepository.js` | cria |
| `lib/repositories/supabase/emailLiberadoRepository.js` | cria |
| `lib/repositories/factory.js` | modifica (registra o repo nos dois backends + indice Mongo) |
| `app/api/[[...path]]/route.js` | modifica (gate no register + 3 rotas admin) |
| `app/page.js` | modifica (card no Painel ETNA + erro no cadastro bloqueado) |
| `tests/backend_test_emails_liberados.py` | cria |

---

### Task 1: Contrato de dominio + migration

**Files:**
- Modify: `packages/domain/src/index.ts:344` (apos a interface `PlataformaAdmin`)
- Modify: `packages/domain/src/index.ts:557` (apos a interface `PlataformaAdminRepository`)
- Create: `supabase/migrations/0030_emails_liberados.sql`

**Interfaces:**
- Produces: `EmailLiberado { id, email, nome, liberado_por, usado_em, created_at }`;
  `EmailLiberadoRepository { findByEmail, list, create, marcarUsado, delete }`

- [ ] **Step 1: Adicionar a interface `EmailLiberado`**

Em `packages/domain/src/index.ts`, logo apos a interface `PlataformaAdmin`
(depois da linha `}` que fecha ela, por volta da linha 344), adicionar:

```ts
/**
 * E-mail liberado pelo dono da ETNA para completar `POST /auth/register`.
 * Sem `empresa_id` de proposito — igual a `PlataformaAdmin`, e
 * infraestrutura da PLATAFORMA, nao de um tenant (a empresa ainda nem
 * existe quando este registro e consultado). `usado_em` comeca `null` e e
 * preenchido no momento em que o cadastro com aquele e-mail e aceito — da
 * pro Painel ETNA mostrar "aguardando cadastro" vs "ja usado em DD/MM" sem
 * cruzar com a tabela de usuarios.
 */
export interface EmailLiberado {
  id: UUID;
  email: string;
  nome: string;
  liberado_por: string;
  usado_em: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Adicionar a interface `EmailLiberadoRepository`**

Logo apos a interface `PlataformaAdminRepository` (depois da linha `}` que
fecha ela, por volta da linha 557), adicionar:

```ts
export interface EmailLiberadoRepository {
  findByEmail(email: string): Promise<EmailLiberado | null>;
  /** Mais recentes primeiro — mesma ordenacao que o Painel ETNA usa em toda listagem administrativa. */
  list(): Promise<EmailLiberado[]>;
  create(entity: EmailLiberado): Promise<EmailLiberado>;
  /** Webhook logico do proprio cadastro: `POST /auth/register` chama isto ao aceitar um e-mail liberado. */
  marcarUsado(email: string): Promise<void>;
  delete(id: UUID): Promise<void>;
}
```

- [ ] **Step 3: Escrever a migration**

Criar `supabase/migrations/0030_emails_liberados.sql`:

```sql
-- ============================================================================
-- Restaurant OS :: Migration 0030 :: Emails liberados (controle de acesso ao cadastro)
-- ============================================================================
-- Ate aqui POST /auth/register era aberto: qualquer pessoa completava o
-- formulario e criava uma empresa nova, sem nenhuma aprovacao do dono.
-- Pedido explicito do dono (2026-08-19): "eu como dono devo ter a
-- possibilidade de adicionar os e-mails que podem ter acesso ao sistema".
--
-- Mesmo espirito de `plataforma_admins` (migration 0027): infraestrutura da
-- PLATAFORMA (a ETNA), nao de um tenant — sem coluna empresa_id (a empresa
-- ainda nem existe quando este registro e consultado), sem RLS policy,
-- acesso so via service_role + checagem em route.js
-- (`superpowers/skills/... exigePlataformaAdmin()`).
--
-- `usado_em` comeca NULL e e preenchido no momento em que POST /auth/register
-- daquele e-mail e aceito — da pro Painel ETNA mostrar "aguardando cadastro"
-- vs "empresa ja criada em DD/MM" sem precisar cruzar com `usuarios`.
create table public.emails_liberados (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  nome text not null default '',
  liberado_por text not null default '',
  usado_em timestamptz,
  created_at timestamptz not null default now()
);

alter table public.emails_liberados enable row level security;
```

- [ ] **Step 4: Testar a migration em transacao com rollback contra producao**

```bash
cd "/c/Users/tanel/Documents/OS Restaurante/Lanchonete" && set -a && source .env && set +a && node -e "
const { Client } = require('pg')
const fs = require('fs')
const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca: fs.readFileSync('supabase/prod-ca-2021.crt', 'utf8'), rejectUnauthorized: true } })
client.connect().then(async () => {
  console.log('Connected to production database')
  await client.query('BEGIN')
  console.log('Transaction started: BEGIN')
  await client.query(fs.readFileSync('supabase/migrations/0030_emails_liberados.sql', 'utf8'))
  console.log('Migration executed')
  const cols = await client.query(\"select column_name, data_type, is_nullable from information_schema.columns where table_name='emails_liberados' order by ordinal_position\")
  console.log('Query result:', cols.rows)
  await client.query('ROLLBACK')
  console.log('Transaction rolled back: ROLLBACK completed')
  await client.end()
  console.log('Connection closed')
})
"
```

Expected: log mostrando cada etapa (BEGIN, Migration executed, 6 colunas
listadas: `id`, `email`, `nome`, `liberado_por`, `usado_em`, `created_at`),
ROLLBACK completed. Depois, rodar uma segunda consulta confirmando que a
tabela NAO existe mais em producao (mesmo padrao de verificacao pos-rollback
usado na migration 0029):

```bash
cd "/c/Users/tanel/Documents/OS Restaurante/Lanchonete" && set -a && source .env && set +a && node -e "
const { Client } = require('pg')
const fs = require('fs')
const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { ca: fs.readFileSync('supabase/prod-ca-2021.crt', 'utf8'), rejectUnauthorized: true } })
client.connect().then(async () => {
  const r = await client.query(\"select table_name from information_schema.tables where table_name='emails_liberados'\")
  console.log('emails_liberados existe em producao apos rollback:', r.rows.length > 0 ? 'SIM (ERRO!)' : 'NAO (correto)')
  await client.end()
})
"
```

Expected: `NAO (correto)`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/index.ts supabase/migrations/0030_emails_liberados.sql
git commit -m "feat(acesso): contrato de dominio + migration para emails_liberados"
```

---

### Task 2: Repository layer (Mongo, Supabase, factory)

**Files:**
- Create: `lib/repositories/mongo/emailLiberadoRepository.js`
- Create: `lib/repositories/supabase/emailLiberadoRepository.js`
- Modify: `lib/repositories/factory.js`

**Interfaces:**
- Consumes: `EmailLiberado`/`EmailLiberadoRepository` do contrato (Task 1)
- Produces: `emailLiberadoRepo` disponivel em `repos` (via `getRepositories()`),
  usado pela Task 3 (gate) e Task 4 (rotas admin)

- [ ] **Step 1: Implementar o repositorio Mongo**

Criar `lib/repositories/mongo/emailLiberadoRepository.js`:

```js
/**
 * Mongo*Repository: ver comentario em categoriaRepository.js. E-mails
 * liberados pelo dono para completar POST /auth/register — infraestrutura
 * da plataforma (ETNA), sem escopo de empresa, mesmo espirito de
 * plataformaAdminRepository.js.
 */
export function createEmailLiberadoRepository(database) {
  const col = database.collection('emails_liberados')
  return {
    async findByEmail(email) {
      return await col.findOne({ email })
    },
    async list() {
      return await col.find({}).sort({ created_at: -1 }).toArray()
    },
    async create(entity) {
      await col.insertOne(entity)
      return entity
    },
    async marcarUsado(email) {
      await col.updateOne({ email }, { $set: { usado_em: new Date() } })
    },
    async delete(id) {
      await col.deleteOne({ id })
    },
  }
}
```

- [ ] **Step 2: Implementar o repositorio Supabase**

Criar `lib/repositories/supabase/emailLiberadoRepository.js`:

```js
import { unwrap } from './_shared.js'

/**
 * Supabase Repository para emails_liberados — e-mails que o dono da ETNA
 * liberou para completar o cadastro. Sem escopo de empresa (a empresa ainda
 * nem existe quando este registro e consultado), mesmo espirito de
 * plataformaAdminRepository.js.
 */
export function createEmailLiberadoRepository(supabase) {
  return {
    async findByEmail(email) {
      return unwrap(await supabase.from('emails_liberados').select('*').eq('email', email).maybeSingle())
    },
    async list() {
      return unwrap(await supabase.from('emails_liberados').select('*').order('created_at', { ascending: false }))
    },
    async create(entity) {
      return unwrap(await supabase.from('emails_liberados').insert(entity).select().single())
    },
    async marcarUsado(email) {
      unwrap(await supabase.from('emails_liberados').update({ usado_em: new Date() }).eq('email', email))
    },
    async delete(id) {
      unwrap(await supabase.from('emails_liberados').delete().eq('id', id))
    },
  }
}
```

- [ ] **Step 3: Registrar o repositorio na factory**

Em `lib/repositories/factory.js`, adicionar os dois imports logo apos os de
`plataformaAdmin` (linhas 46 e 71):

```js
import { createEmailLiberadoRepository as mongoEmailLiberado } from './mongo/emailLiberadoRepository'
```

```js
import { createEmailLiberadoRepository as sbEmailLiberado } from './supabase/emailLiberadoRepository'
```

Em `ensureMongoIndexes` (dentro do `try`, logo apos a linha do indice de
`plataforma_admins`, por volta da linha 120), adicionar:

```js
    await database.collection('emails_liberados').createIndex({ email: 1 }, { unique: true })
```

Em `buildMongoRepositories`, logo apos a linha `plataformaAdminRepo: mongoPlataformaAdmin(database),`:

```js
    emailLiberadoRepo: mongoEmailLiberado(database),
```

Em `buildSupabaseRepositories`, logo apos a linha `plataformaAdminRepo: sbPlataformaAdmin(supabase),`:

```js
    emailLiberadoRepo: sbEmailLiberado(supabase),
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check lib/repositories/mongo/emailLiberadoRepository.js
node --check lib/repositories/supabase/emailLiberadoRepository.js
node --check lib/repositories/factory.js
```

Expected: sem output em nenhum dos tres (sucesso).

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/mongo/emailLiberadoRepository.js lib/repositories/supabase/emailLiberadoRepository.js lib/repositories/factory.js
git commit -m "feat(acesso): emailLiberadoRepo (Mongo + Supabase), registrado na factory"
```

---

### Task 3: Gate em `POST /auth/register`

**Files:**
- Modify: `app/api/[[...path]]/route.js:617-621` (destructuring de `repos`)
- Modify: `app/api/[[...path]]/route.js:674-675` (adicionar o gate)
- Modify: `app/api/[[...path]]/route.js:730` (marcar usado apos sucesso)

**Interfaces:**
- Consumes: `emailLiberadoRepo.findByEmail(email)`, `emailLiberadoRepo.marcarUsado(email)` (Task 2)
- Produces: nenhuma interface nova — so o comportamento do endpoint muda

**Contexto para quem for implementar esta task:** os numeros de linha abaixo
sao do estado do arquivo ANTES desta task. Confirme contra o conteudo real
do arquivo antes de editar — se o texto ao redor nao bater exatamente com o
mostrado aqui, pare e reporte BLOCKED em vez de adivinhar.

- [ ] **Step 1: Adicionar `emailLiberadoRepo` ao destructuring de `repos`**

Em `route.js`, dentro do `try`, o destructuring atual (por volta da linha
617) e:

```js
    const {
      categoriaRepo, produtoRepo, clienteRepo, usuarioRepo, transacaoRepo,
      auditoriaRepo, integracaoRepo, mesaRepo, conversaRepo, mensagemRepo,
      pedidoRepo, comandaRepo, pagamentoRepo, empresaRepo, webhookEventsRepo,
      kdsTokenRepo, entregadorRepo, caixaRepo, caixaMovimentoRepo, contaRepo,
      assinaturaRepo, assinaturaPagamentoRepo, plataformaAdminRepo,
    } = repos
```

Trocar a ultima linha por:

```js
      assinaturaRepo, assinaturaPagamentoRepo, plataformaAdminRepo, emailLiberadoRepo,
```

- [ ] **Step 2: Adicionar o gate logo apos a checagem de e-mail duplicado**

Em `route.js`, dentro do handler `POST /auth/register`, o trecho atual
(por volta da linha 673-677) e:

```js
      const emailNorm = String(email).toLowerCase().trim()
      const exists = await usuarioRepo.findByEmail(emailNorm)
      if (exists) return err('E-mail ja cadastrado', 409)

      const empresa_id = uuidv4()
```

Trocar por:

```js
      const emailNorm = String(email).toLowerCase().trim()
      const exists = await usuarioRepo.findByEmail(emailNorm)
      if (exists) return err('E-mail ja cadastrado', 409)

      // Controle de acesso ao cadastro (pedido do dono, 2026-08-19): so
      // quem foi liberado no Painel ETNA consegue completar o cadastro.
      // `SIGNUP_ALLOWLIST_DISABLED=1` desliga o gate — usado SO pela suite
      // local/CI (mesmo padrao de RATE_LIMIT_DISABLED ja existente neste
      // projeto), nunca setada em producao.
      if (process.env.SIGNUP_ALLOWLIST_DISABLED !== '1') {
        const liberado = await emailLiberadoRepo.findByEmail(emailNorm)
        if (!liberado) {
          return err('Este e-mail ainda nao foi liberado para cadastro. Fale com a ETNA para liberar seu acesso.', 403)
        }
      }

      const empresa_id = uuidv4()
```

- [ ] **Step 3: Marcar o e-mail como usado apos o cadastro ser aceito**

O trecho atual, logo apos `await usuarioRepo.create(usuario)` (por volta da
linha 719-730), termina em:

```js
      const ctx = { empresa_id, usuario_id, nome, papel: 'OWNER' }
      await audit(repos, ctx, 'register', 'empresa', empresa_id, { empresa_nome })

      const token = signToken({ usuario_id, empresa_id, papel: 'OWNER' })
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS.OWNER })
    }
```

Trocar por (adiciona a chamada a `marcarUsado`, guardada pela mesma flag do
Step 2 — se o gate estava desligado para este cadastro, tambem nao ha nada
para marcar):

```js
      const ctx = { empresa_id, usuario_id, nome, papel: 'OWNER' }
      await audit(repos, ctx, 'register', 'empresa', empresa_id, { empresa_nome })
      if (process.env.SIGNUP_ALLOWLIST_DISABLED !== '1') {
        await emailLiberadoRepo.marcarUsado(emailNorm)
      }

      const token = signToken({ usuario_id, empresa_id, papel: 'OWNER' })
      return json({ token, usuario: clean(usuario), empresa: clean(empresa), permissions: PERMISSIONS.OWNER })
    }
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check "app/api/[[...path]]/route.js"
```

- [ ] **Step 5: Verificar manualmente com o servidor local (SEM a flag de bypass)**

Servidor local por padrao NAO tem `SIGNUP_ALLOWLIST_DISABLED=1` a menos que
voce mesmo tenha setado — confirme que a variavel esta ausente do ambiente
atual antes de testar (`echo $SIGNUP_ALLOWLIST_DISABLED` deve vir vazio).
Reinicie o servidor se necessario para garantir isso.

```bash
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"empresa_nome":"Teste Gate","nome":"Dono","email":"gate-sem-liberar@test.com","senha":"senha123"}'
```

Expected: JSON com `"error"` contendo "nao foi liberado", HTTP 403 (adicione
`-w '\n%{http_code}\n'` ao curl para ver o status).

- [ ] **Step 6: Commit**

```bash
git add "app/api/[[...path]]/route.js"
git commit -m "feat(acesso): gate de allowlist em POST /auth/register"
```

---

### Task 4: Rotas administrativas (Painel ETNA)

**Files:**
- Modify: `app/api/[[...path]]/route.js` (3 rotas novas, proximas de `/plataforma/empresas`)

**Interfaces:**
- Consumes: `exigePlataformaAdmin()` (ja existe, `route.js:1153-1154`),
  `emailLiberadoRepo.{list,create,delete}` (Task 2)
- Produces: `GET /plataforma/emails-liberados`, `POST /plataforma/emails-liberados`,
  `DELETE /plataforma/emails-liberados/:id`

- [ ] **Step 1: `GET /plataforma/emails-liberados`**

Em `route.js`, logo apos o bloco `if (route === '/plataforma/eu' && method === 'GET') { ... }`
(por volta da linha 1163), adicionar:

```js
    if (route === '/plataforma/emails-liberados' && method === 'GET') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const lista = await emailLiberadoRepo.list()
      return json(lista.map(clean))
    }
```

- [ ] **Step 2: `POST /plataforma/emails-liberados`**

Logo apos o bloco do Step 1:

```js
    /**
     * Libera um e-mail para completar o cadastro. `email` e a UNICA chave
     * de negocio (coluna UNIQUE na migration 0030) — tentar liberar o mesmo
     * e-mail duas vezes e erro do operador, nao caso normal, entao devolve
     * 409 em vez de silenciosamente devolver o registro existente.
     */
    if (route === '/plataforma/emails-liberados' && method === 'POST') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      const b = (await request.json()) || {}
      if (!b.email) return err('email obrigatorio')
      const emailNorm = String(b.email).toLowerCase().trim()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) return err('email invalido')
      const existente = await emailLiberadoRepo.findByEmail(emailNorm)
      if (existente) return err('Este e-mail ja esta liberado', 409)
      const entity = {
        id: uuidv4(), email: emailNorm, nome: b.nome || '',
        liberado_por: ctx.email || ctx.nome || '', usado_em: null, created_at: new Date(),
      }
      await emailLiberadoRepo.create(entity)
      await audit(repos, ctx, 'liberar_email', 'email_liberado', entity.id, { email: emailNorm })
      return json(clean(entity), 201)
    }
```

- [ ] **Step 3: `DELETE /plataforma/emails-liberados/:id`**

Logo apos o bloco do Step 2:

```js
    if (seg[0] === 'plataforma' && seg[1] === 'emails-liberados' && seg[2] && method === 'DELETE') {
      const negado = await exigePlataformaAdmin(); if (negado) return negado
      await emailLiberadoRepo.delete(seg[2])
      await audit(repos, ctx, 'remover_email_liberado', 'email_liberado', seg[2], {})
      return json({ ok: true })
    }
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check "app/api/[[...path]]/route.js"
```

- [ ] **Step 5: Verificar manualmente end-to-end (servidor local rodando)**

Como admin da plataforma nao existe por padrao localmente, este passo
assume que voce ja tem um e-mail cadastrado em `plataforma_admins` local
(mesmo processo usado para os testes do Painel ETNA em sessoes anteriores).
Se nao tiver, insira um registro de teste diretamente no Mongo local antes
de continuar:

```bash
cd "/c/Users/tanel/Documents/OS Restaurante/Lanchonete" && python - <<'EOF'
from pymongo import MongoClient
import uuid
db = MongoClient("mongodb://localhost:27017")["restaurant_os_dev"]
db.plataforma_admins.update_one(
  {"email": "admin-teste-acesso@etna.com"},
  {"$set": {"id": str(uuid.uuid4()), "email": "admin-teste-acesso@etna.com", "nome": "Admin Teste", "ativo": True, "created_at": __import__("datetime").datetime.utcnow()}},
  upsert=True,
)
print("admin de teste pronto")
EOF
```

Registre uma empresa comum com esse e-mail (`POST /auth/register`, com
`SIGNUP_ALLOWLIST_DISABLED=1` no servidor OU liberando o proprio e-mail
antes), pegue o token retornado, e exercite o fluxo completo:

```bash
TOKEN="<token retornado pelo /auth/register>"
curl -s -X POST http://localhost:3000/api/plataforma/emails-liberados -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"prospect@teste.com","nome":"Prospect Teste"}'
curl -s http://localhost:3000/api/plataforma/emails-liberados -H "Authorization: Bearer $TOKEN"
```

Expected: o POST devolve o registro criado (201) com `usado_em: null`; o
GET devolve uma lista incluindo esse registro.

- [ ] **Step 6: Commit**

```bash
git add "app/api/[[...path]]/route.js"
git commit -m "feat(acesso): rotas admin GET/POST/DELETE /plataforma/emails-liberados"
```

---

### Task 5: Testes de integracao

**Files:**
- Create: `tests/backend_test_emails_liberados.py`

**Interfaces:**
- Consumes: todas as rotas das Tasks 3 e 4

**Contexto:** este arquivo de teste PRECISA rodar contra um servidor que
tenha `SIGNUP_ALLOWLIST_DISABLED=1` setado (mesmo servidor usado pelas
outras 18 suites Python desta sessao) — SENAO os proprios helpers de setup
(`criar_empresa()`, usados por praticamente todo teste deste arquivo e de
todas as outras suites) parariam de funcionar. Os testes que verificam o
COMPORTAMENTO do gate propriamente dito (`test_cadastro_sem_email_liberado_da_403`,
`test_cadastro_com_email_liberado_funciona`) fazem a chamada HTTP direto
`requests.post`, sem usar o helper `criar_empresa()` — e por isso conseguem
testar o gate real mesmo com o bypass ligado no resto do ambiente: o bypass
so desativa a CHECAGEM, ele nao impede que o codigo do gate seja alcancado
e testado explicitamente quando o teste FORCA a checagem a rodar chamando a
rota sem passar pelo helper. Isto so funciona porque `SIGNUP_ALLOWLIST_DISABLED=1`
desliga o `if` inteiro (Task 3, Step 2) — entao **estes dois testes especificos
precisam ser corridos manualmente contra um servidor SEM a flag**, documentado
no Step 2 abaixo. Os demais testes deste arquivo (rotas admin) funcionam
normalmente com o bypass ligado, porque nao dependem do gate.

- [ ] **Step 1: Escrever os testes das rotas administrativas (rodam com o bypass ligado, junto do resto da suite)**

Criar `tests/backend_test_emails_liberados.py`:

```python
"""Controle de acesso ao cadastro: allowlist de e-mails liberados pelo
dono da ETNA (Painel ETNA) para completar POST /auth/register.

O gate em si (POST /auth/register recusando e-mail nao liberado) NAO e
testavel nesta suite rodando com SIGNUP_ALLOWLIST_DISABLED=1 (ambiente
padrao de toda a regressao local) — ver test_gate_manual.py para os 2
testes que precisam de um servidor SEM a flag.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def criar_empresa(nome):
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}, email


def promover_plataforma_admin(email):
    """Insere direto no Mongo local — mesmo mecanismo ja usado nesta sessao
    para testar o Painel ETNA (nao ha endpoint de auto-promocao, de proposito:
    so quem ja tem acesso ao banco vira admin da plataforma)."""
    from pymongo import MongoClient
    import uuid
    from datetime import datetime, timezone
    db = MongoClient("mongodb://localhost:27017")["restaurant_os_dev"]
    db.plataforma_admins.update_one(
        {"email": email},
        {"$set": {"id": str(uuid.uuid4()), "email": email, "nome": "Admin Teste", "ativo": True, "created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )


def test_liberar_email_cria_registro_pendente():
    headers, email = criar_empresa("Acesso Admin Liberar")
    promover_plataforma_admin(email)
    alvo = f"prospect-{os.urandom(4).hex()}@teste.com"
    r = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo, "nome": "Prospect"})
    assert r.status_code == 201, r.text
    corpo = r.json()
    assert corpo["email"] == alvo
    assert corpo["usado_em"] is None


def test_liberar_o_mesmo_email_duas_vezes_da_409():
    headers, email = criar_empresa("Acesso Admin Duplicado")
    promover_plataforma_admin(email)
    alvo = f"dup-{os.urandom(4).hex()}@teste.com"
    primeiro = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    assert primeiro.status_code == 201
    segundo = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    assert segundo.status_code == 409


def test_liberar_email_com_formato_invalido_e_recusado():
    headers, email = criar_empresa("Acesso Admin Formato")
    promover_plataforma_admin(email)
    r = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": "nao-e-email"})
    assert r.status_code == 400


def test_listar_emails_liberados_mostra_status_usado():
    headers, email = criar_empresa("Acesso Admin Listar")
    promover_plataforma_admin(email)
    alvo = f"listagem-{os.urandom(4).hex()}@teste.com"
    requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    lista = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers).json()
    achado = next(i for i in lista if i["email"] == alvo)
    assert achado["usado_em"] is None


def test_remover_email_liberado_tira_da_lista():
    headers, email = criar_empresa("Acesso Admin Remover")
    promover_plataforma_admin(email)
    alvo = f"remover-{os.urandom(4).hex()}@teste.com"
    criado = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo}).json()
    r = requests.delete(f"{BASE_URL}/plataforma/emails-liberados/{criado['id']}", headers=headers)
    assert r.status_code == 200
    lista = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers).json()
    assert not any(i["id"] == criado["id"] for i in lista)


def test_rotas_admin_exigem_admin_da_plataforma():
    headers, email = criar_empresa("Acesso Nao Admin")
    # NAO promove este e-mail a plataforma_admins — usuario comum.
    r = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers)
    assert r.status_code == 403
    r2 = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": "x@x.com"})
    assert r2.status_code == 403


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
```

- [ ] **Step 2: Rodar esta suite junto do resto da regressao (bypass ligado)**

```bash
BASE_URL=http://localhost:3000/api PYTHONIOENCODING=utf-8 python -m pytest tests/backend_test_emails_liberados.py -v
```

Expected: `6 passed`.

- [ ] **Step 3: Testar o gate propriamente dito, MANUALMENTE, contra um servidor SEM a flag**

Este passo nao entra na suite automatizada porque exigiria derrubar e subir
o servidor com uma variavel de ambiente diferente no meio da regressao —
mais frágil do que vale a pena. Pare o servidor local, suba de novo SEM
`SIGNUP_ALLOWLIST_DISABLED`, e rode:

```bash
# 1. Sem liberar, deve falhar:
curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"empresa_nome":"Gate Manual A","nome":"D","email":"gate-manual-a@test.com","senha":"senha123"}'
```

Expected: corpo com `"error"` contendo "nao foi liberado", ultima linha `403`.

```bash
# 2. Promove um admin de plataforma ja existente (reaproveite um da Task 4)
#    para liberar o e-mail, depois tenta de novo:
TOKEN="<token de um admin da plataforma>"
curl -s -X POST http://localhost:3000/api/plataforma/emails-liberados -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"gate-manual-a@test.com"}'
curl -s -w '\n%{http_code}\n' -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"empresa_nome":"Gate Manual A","nome":"D","email":"gate-manual-a@test.com","senha":"senha123"}'
```

Expected: segundo cadastro devolve `200` com `token`. Confirme tambem que o
registro em `emails_liberados` ficou com `usado_em` preenchido:

```bash
curl -s http://localhost:3000/api/plataforma/emails-liberados -H "Authorization: Bearer $TOKEN" | grep -o '"email":"gate-manual-a@test.com"[^}]*'
```

Expected: `usado_em` no trecho encontrado NAO e `null`.

Depois de validar, **religue o servidor com `SIGNUP_ALLOWLIST_DISABLED=1`**
antes de rodar a regressao completa no passo seguinte — senão as outras 17
suites Python (que criam dezenas de empresas via `criar_empresa()` sem
liberar e-mail nenhum) falham em cascata.

- [ ] **Step 4: Rodar a regressao completa (com o bypass religado)**

```bash
BASE_URL=http://localhost:3000/api PYTHONIOENCODING=utf-8 python tests/run_all.py
```

Expected: todas as suites verdes, exceto `backend_test_rate_limit.py` (so
falha quando o servidor roda com `RATE_LIMIT_DISABLED=1`, comportamento
sempre esperado nesta maquina — ver HANDOFF.md).

- [ ] **Step 5: Commit**

```bash
git add tests/backend_test_emails_liberados.py
git commit -m "test(acesso): 6 testes de integracao das rotas admin de emails_liberados"
```

---

### Task 6: Frontend — card no Painel ETNA

**Files:**
- Modify: `app/page.js` (novo componente + chamada dentro de `PainelPlataforma`)

**Interfaces:**
- Consumes: `GET/POST/DELETE /plataforma/emails-liberados` (Tasks 3-4)

**Contexto confirmado no codigo:** `PainelPlataforma` (`app/page.js:4293`)
ja carrega dados via `api('/plataforma/empresas')` e renderiza uma
`<Card>` com a tabela de empresas, seguida de tres dialogos condicionais
(`AssinaturaDialog`, `PagamentoDialog`, `PausarAvisoDialog`) logo antes do
`</div>` final do componente (`app/page.js:4381-4386`). Este task adiciona
um componente NOVO e AUTOSSUFICIENTE, `EmailsLiberadosCard`, com seu proprio
`useState`/`useEffect`/carregamento — nao mistura estado com
`PainelPlataforma`. Os icones `Plus`, `Trash2` e `UserPlus` ja estao
importados de `lucide-react` no topo do arquivo — nenhum import novo
necessario.

- [ ] **Step 1: Criar o componente `EmailsLiberadosCard`**

Em `app/page.js`, logo ANTES de `function PainelPlataforma()` (linha 4293),
adicionar:

```jsx
/**
 * Card do Painel ETNA para liberar/remover e-mails que podem completar
 * POST /auth/register. Componente proprio (nao estado de PainelPlataforma)
 * porque tem seu ciclo de carregamento independente da tabela de empresas.
 */
function EmailsLiberadosCard() {
  const [lista, setLista] = useState(null)
  const [novoEmail, setNovoEmail] = useState('')
  const [novoNome, setNovoNome] = useState('')
  const [liberando, setLiberando] = useState(false)
  const [removendo, setRemovendo] = useState(null)

  const load = useCallback(async () => {
    try { setLista(await api('/plataforma/emails-liberados')) } catch (e) { toast.error(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const liberar = async (e) => {
    e.preventDefault()
    if (!novoEmail) return toast.error('Informe o e-mail')
    setLiberando(true)
    try {
      await api('/plataforma/emails-liberados', { method: 'POST', body: { email: novoEmail, nome: novoNome } })
      toast.success('E-mail liberado')
      setNovoEmail(''); setNovoNome('')
      await load()
    } catch (e) { toast.error(e.message) } finally { setLiberando(false) }
  }

  const remover = async (item) => {
    setRemovendo(item.id)
    try {
      await api(`/plataforma/emails-liberados/${item.id}`, { method: 'DELETE' })
      toast.success('Liberacao removida')
      await load()
    } catch (e) { toast.error(e.message) } finally { setRemovendo(null) }
  }

  if (!lista) return <Empty>Carregando…</Empty>

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><UserPlus className="h-4 w-4" />E-mails liberados para cadastro</CardTitle>
        <CardDescription>Somente e-mails liberados aqui conseguem completar o cadastro de uma empresa nova.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={liberar} className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 flex-1 min-w-[200px]">
            <Label className="text-xs">E-mail</Label>
            <Input type="email" placeholder="prospect@email.com" value={novoEmail} onChange={(e) => setNovoEmail(e.target.value)} />
          </div>
          <div className="space-y-1 flex-1 min-w-[160px]">
            <Label className="text-xs">Nome (opcional)</Label>
            <Input placeholder="Para voce lembrar quem e" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
          </div>
          <Button type="submit" disabled={liberando}>
            <Plus className="h-4 w-4 mr-1" />{liberando ? 'Liberando…' : 'Liberar e-mail'}
          </Button>
        </form>
        {lista.length === 0 ? (
          <div className="text-sm text-muted-foreground">Nenhum e-mail liberado ainda.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>E-mail</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Acoes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lista.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{item.nome || '—'}</TableCell>
                  <TableCell>
                    {item.usado_em
                      ? <Badge variant="secondary">usado em {new Date(item.usado_em).toLocaleDateString('pt-BR')}</Badge>
                      : <Badge className="bg-amber-600 hover:bg-amber-600">aguardando cadastro</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!item.usado_em && (
                      <Button size="sm" variant="outline" disabled={removendo === item.id} onClick={() => remover(item)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

```

- [ ] **Step 2: Renderizar o card dentro de `PainelPlataforma`**

Em `app/page.js:4381`, o trecho atual e:

```jsx
      </Card>

      {editando && <AssinaturaDialog empresa={editando} onClose={() => setEditando(null)} onSaved={() => { setEditando(null); load() }} />}
```

Trocar por (adiciona o card novo entre a tabela de empresas e os dialogos):

```jsx
      </Card>

      <EmailsLiberadosCard />

      {editando && <AssinaturaDialog empresa={editando} onClose={() => setEditando(null)} onSaved={() => { setEditando(null); load() }} />}
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check app/page.js
```

- [ ] **Step 4: Verificar visualmente com Playwright (servidor local rodando, mesmo admin de teste da Task 4)**

Navegue ate a tela do Painel ETNA autenticado como o admin de teste, e
confirme: o card "E-mails liberados para cadastro" aparece abaixo da
tabela de empresas; liberar um e-mail novo faz aparecer na lista com
badge "aguardando cadastro"; o botao de remover some assim que um e-mail
e marcado como usado (verificavel completando um cadastro de verdade com
aquele e-mail, com `SIGNUP_ALLOWLIST_DISABLED` desligado, como na Task 5
Step 3).

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat(acesso): card de e-mails liberados no Painel ETNA"
```

---

### Task 7: Frontend — erro de cadastro bloqueado na tela de login

**Files:**
- Modify: `app/page.js:269-290` (componente `AuthScreen`, estado + `submit`)
- Modify: `app/page.js:344` (formulario, apos o `</form>`)

**Interfaces:**
- Consumes: mensagem de erro exata da Task 3
  (`'Este e-mail ainda nao foi liberado para cadastro. Fale com a ETNA para liberar seu acesso.'`),
  componente `BotaoWhatsApp`/constante `WHATSAPP_ETNA` ja existentes (`app/page.js:372-`)

**Contexto confirmado no codigo:** `api()` (`app/page.js:67-90`) lanca
`new Error(data.error)` SEM anexar o status HTTP — entao a unica forma de
distinguir este erro especifico dos demais e pelo TEXTO da mensagem. O
backend (Task 3) usa um texto fixo e exclusivo desta situacao; o frontend
casa por um trecho estavel dele (`'nao foi liberado'`), nao a string
inteira, para nao quebrar se a pontuacao mudar.

- [ ] **Step 1: Adicionar estado para o erro de cadastro bloqueado**

Em `app/page.js`, dentro de `AuthScreen` (por volta da linha 271), o
estado atual e:

```jsx
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ empresa_nome: '', nome: '', email: '', senha: '' })
```

Adicionar logo apos:

```jsx
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ empresa_nome: '', nome: '', email: '', senha: '' })
  const [emailNaoLiberado, setEmailNaoLiberado] = useState(false)
```

- [ ] **Step 2: Detectar o erro especifico no `submit`**

O `submit` atual (linhas 275-290) e:

```jsx
  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register'
      const payload = mode === 'login' ? { email: form.email, senha: form.senha } : form
      const data = await api(path, { method: 'POST', body: payload })
      localStorage.setItem(TOKEN_KEY, data.token)
      toast.success(mode === 'login' ? 'Bem-vindo de volta!' : 'Empresa criada com sucesso!')
      onAuth()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }
```

Trocar por:

```jsx
  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setEmailNaoLiberado(false)
    try {
      const path = mode === 'login' ? '/auth/login' : '/auth/register'
      const payload = mode === 'login' ? { email: form.email, senha: form.senha } : form
      const data = await api(path, { method: 'POST', body: payload })
      localStorage.setItem(TOKEN_KEY, data.token)
      toast.success(mode === 'login' ? 'Bem-vindo de volta!' : 'Empresa criada com sucesso!')
      onAuth()
    } catch (err) {
      if (mode === 'register' && err.message.includes('nao foi liberado')) {
        setEmailNaoLiberado(true)
      } else {
        toast.error(err.message)
      }
    } finally {
      setLoading(false)
    }
  }
```

- [ ] **Step 3: Limpar o aviso ao trocar de modo (login/cadastro)**

O link de troca de modo atual (por volta da linha 358-360) e:

```jsx
            <button className="text-primary font-medium hover:underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Cadastre sua empresa' : 'Fazer login'}
            </button>
```

Trocar por (evita que o aviso de "e-mail bloqueado" continue visivel depois
que a pessoa muda de tela e tenta o login, por exemplo):

```jsx
            <button className="text-primary font-medium hover:underline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setEmailNaoLiberado(false) }}>
              {mode === 'login' ? 'Cadastre sua empresa' : 'Fazer login'}
            </button>
```

- [ ] **Step 4: Adicionar o card de aviso persistente logo apos o formulario**

O trecho atual (linhas 344-349) e:

```jsx
          </form>
          <p className="text-sm text-center text-muted-foreground">
            {mode === 'login' ? 'Não tem conta?' : 'Já possui conta?'}{' '}
```

Trocar por (adiciona o card ENTRE o fechamento do `</form>` e o paragrafo
de troca de modo):

```jsx
          </form>
          {emailNaoLiberado && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
              <p className="text-sm font-medium">Este e-mail ainda nao foi liberado para cadastro.</p>
              <p className="text-sm text-muted-foreground">Fale com a ETNA para liberar seu acesso — e rapido.</p>
              <a
                href={`https://wa.me/${WHATSAPP_ETNA}?text=${encodeURIComponent(`Olá! Tentei me cadastrar no Restaurant OS com o e-mail ${form.email} e recebi um aviso de que preciso liberar meu acesso. Pode me ajudar?`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-emerald-600 hover:underline"
              >
                Falar no WhatsApp
              </a>
            </div>
          )}
          <p className="text-sm text-center text-muted-foreground">
            {mode === 'login' ? 'Não tem conta?' : 'Já possui conta?'}{' '}
```

`WHATSAPP_ETNA` ja e uma constante top-level do modulo (`app/page.js:372`),
acessivel de dentro de `AuthScreen` sem import adicional.

- [ ] **Step 5: Verificar sintaxe**

```bash
node --check app/page.js
```

- [ ] **Step 6: Verificar visualmente com Playwright (servidor local rodando, SEM `SIGNUP_ALLOWLIST_DISABLED`)**

Preencha o formulario de cadastro com um e-mail nunca liberado e envie.
Confirme: nenhum toast generico de erro aparece (o antigo comportamento);
em vez disso, o card amarelo aparece com o texto e o link do WhatsApp;
trocar para "Fazer login" e voltar para "Cadastre sua empresa" faz o card
sumir; liberar o e-mail (via Painel ETNA, Task 6) e tentar de novo funciona
normalmente e leva para dentro do sistema.

Religue `SIGNUP_ALLOWLIST_DISABLED=1` no servidor apos este teste, antes de
qualquer outra verificacao — mesmo cuidado do Task 5 Step 3.

- [ ] **Step 7: Commit**

```bash
git add app/page.js
git commit -m "feat(acesso): aviso com CTA do WhatsApp quando o cadastro e bloqueado"
```

---

## Depois de todas as tasks

- [ ] Rodar `python tests/run_all.py` (com `SIGNUP_ALLOWLIST_DISABLED=1`) —
  todas verdes exceto `rate_limit`
- [ ] Rodar `npx playwright test` (E2E) — confirmar que nenhum fluxo
  existente quebrou (o cadastro usado pelos helpers E2E precisa continuar
  funcionando; se os testes E2E rodam contra um servidor sem a flag, o
  helper `registrarEmpresa` de `e2e/helpers.js` vai precisar do mesmo
  bypass — verificar `playwright.config.js`/`e2e/helpers.js` e, se
  necessario, adicionar `SIGNUP_ALLOWLIST_DISABLED=1` a variavel de
  ambiente do `webServer` do Playwright antes de considerar este item
  concluido)
- [ ] Atualizar `HANDOFF.md` com o item concluido
- [ ] Confirmar em producao, apos o deploy automatico: `GET /plataforma/emails-liberados`
  autenticado como voce mesmo (ja promovido a `plataforma_admins` em
  producao) devolve lista vazia; liberar seu proprio e-mail e o de qualquer
  cliente que ja tenha empresa cadastrada e seguro (o gate so afeta
  CADASTROS NOVOS, nunca login de quem ja existe)
