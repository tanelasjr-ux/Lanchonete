# Controle de Acesso ao Cadastro — Design

**Data:** 2026-08-19
**Escopo:** so o dono da ETNA pode liberar quais e-mails conseguem completar
o cadastro de uma empresa nova (`POST /auth/register`). Login de contas ja
existentes nao muda em nada.

---

## 1. Problema

Hoje `POST /auth/register` e aberto: qualquer pessoa preenche o formulario
e cria uma empresa nova, sem nenhuma aprovacao. Pedido explicito do dono:
*"eu como dono devo ter a possibilidade de adicionar os e-mails que podem
ter acesso ao sistema... hoje qualquer empresa pode fazer o cadastro... e
entrar no sistema, corrija isso."*

Isso muda o modelo comercial de "self-serve total" para "o dono aprova
antes". Tem tensao direta com trabalho ja construido nesta mesma sessao —
o checklist de onboarding (B2), o link "Cadastre sua empresa" na tela de
login, o texto de marketing vendendo cadastro livre — nenhum desses vira
inutil, mas o *ponto de entrada* muda: primeiro o dono libera o e-mail,
so depois a pessoa passa pelo onboarding que ja existe.

## 2. Decisoes tomadas

| Questao | Decisao |
|---|---|
| Mecanismo | **Allowlist ANTES do cadastro** — dono libera o e-mail primeiro; so entao aquele e-mail consegue completar `POST /auth/register` |
| Alternativas descartadas | Aprovacao DEPOIS do cadastro (conta fica pendente) e convite por link unico — ambas dao mais trabalho operacional ao dono do que uma lista simples |
| Link "Cadastre sua empresa" na tela de login | **Continua visivel.** E-mail nao liberado -> erro claro + CTA do WhatsApp — vira parte do funil de vendas, nao um beco sem saida |
| Testes automatizados (17 suites, todas registram empresas o tempo todo) | **`SIGNUP_ALLOWLIST_DISABLED=1`**, mesmo padrao ja usado para `RATE_LIMIT_DISABLED` neste projeto — nunca setada em producao, sempre setada no dev local/CI |
| Revogar acesso de quem ja se cadastrou | **Fora de escopo.** Ja existe: bloquear a empresa inteira no Painel ETNA (`empresas.ativo`). Remover da allowlist so afeta quem ainda nao se cadastrou |
| E-mail reutilizavel apos cadastro? | Nao precisa de trava nova — `usuarioRepo.findByEmail` ja bloqueia (409 "e-mail ja cadastrado") qualquer segunda tentativa com o mesmo e-mail, allowlist ou nao |

## 3. Modelo de dados

### 3.1 Migration `0030_emails_liberados.sql`

Mesmo espirito de `plataforma_admins` (migration 0027): infraestrutura da
**plataforma**, nao de um tenant — sem RLS policy, acesso so via
service_role + checagem em `route.js`.

```sql
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

`usado_em` comeca `null` e e preenchido no momento em que o `POST
/auth/register` daquele e-mail e aceito — da pro Painel ETNA mostrar
"aguardando cadastro" vs "empresa ja criada em DD/MM", sem precisar cruzar
com a tabela de usuarios.

### 3.2 Contrato de dominio

`packages/domain/src/index.ts` ganha:

```ts
export interface EmailLiberado {
  id: UUID; email: string; nome: string;
  liberado_por: string; usado_em: string | null; created_at: string;
}

export interface EmailLiberadoRepository {
  findByEmail(email: string): Promise<EmailLiberado | null>;
  list(): Promise<EmailLiberado[]>;
  create(entity: Omit<EmailLiberado, 'id' | 'usado_em' | 'created_at'>): Promise<EmailLiberado>;
  marcarUsado(email: string): Promise<void>;
  delete(id: UUID): Promise<void>;
}
```

### 3.3 Repositories

Mesmo padrao minimo de `plataformaAdminRepository` (Mongo real, Supabase
via `unwrap`) — sem RLS/tenant, so `email` como chave de negocio.

## 4. Backend

### 4.1 O gate em `POST /auth/register`

Insercao logo apos a checagem existente de e-mail duplicado
(`route.js:674-675`, `if (exists) return err('E-mail ja cadastrado', 409)`),
antes de criar `empresa_id`:

```js
if (process.env.SIGNUP_ALLOWLIST_DISABLED !== '1') {
  const liberado = await emailLiberadoRepo.findByEmail(emailNorm)
  if (!liberado) {
    return err('Este e-mail ainda nao foi liberado para cadastro. Fale com a ETNA para liberar seu acesso.', 403)
  }
}
```

Apos criar a empresa e o usuario com sucesso (mesmo ponto onde `audit()`
ja e chamado para o registro), marca o e-mail como usado:

```js
if (process.env.SIGNUP_ALLOWLIST_DISABLED !== '1') {
  await emailLiberadoRepo.marcarUsado(emailNorm)
}
```

### 4.2 Endpoints de gestao (Painel ETNA)

Mesma familia de `/plataforma/*` ja existente (`route.js`), protegidos por
`exigePlataformaAdmin()` (a mesma funcao ja usada por
`/plataforma/empresas`, `/plataforma/assinaturas/*`):

| Metodo | Rota | O que faz |
|---|---|---|
| `GET` | `/plataforma/emails-liberados` | lista todos, mais recentes primeiro |
| `POST` | `/plataforma/emails-liberados` | `{email, nome}` — libera um novo |
| `DELETE` | `/plataforma/emails-liberados/:id` | remove (so faz sentido para um ainda nao usado — a UI esconde o botao quando `usado_em` esta preenchido, mas o backend nao precisa bloquear: remover um ja usado e inocuo, so tira da lista) |

`POST` valida formato de e-mail e reaproveita o mesmo normalizador
(`toLowerCase().trim()`) que `/auth/register` ja usa, para nunca cadastrar
"Joao@X.com" na allowlist e depois falhar bater com "joao@x.com" no
cadastro real.

## 5. Frontend

### 5.1 Painel ETNA — nova secao

Dentro do componente `PainelPlataforma` (`app/page.js`), um card novo
acima ou abaixo da tabela de empresas: lista de e-mails liberados (e-mail,
nome, status "aguardando" / "usado em DD/MM"), campo + botao "Liberar
e-mail", botao remover (so nas linhas ainda nao usadas).

### 5.2 Tela de login — erro do cadastro bloqueado

Hoje `AuthScreen`'s `submit()` (`app/page.js:275-290`) trata qualquer erro
de `/auth/register` com um `toast.error(err.message)` generico — some em
poucos segundos, sem CTA. Para especificamente o erro 403 desta allowlist,
o formulario passa a mostrar um card persistente na propria tela (mesmo
padrao visual ja usado por `AvisoAssinatura`), com o texto do erro e um
botao "Falar no WhatsApp" reaproveitando `BotaoWhatsApp`/`WHATSAPP_ETNA` ja
existentes (`origem: 'cadastro-bloqueado'` na mensagem pre-preenchida, para
o dono saber de onde veio sem perguntar) — o balao flutuante generico
continua ali tambem, mas este card e o que guia quem acabou de esbarrar no
bloqueio.

## 6. Testes

- **Unitario:** nenhum modulo puro novo (o gate e so uma consulta +
  comparacao, sem calculo).
- **Integracao** (`tests/backend_test_emails_liberados.py`): cadastro sem
  e-mail liberado -> 403; liberar e depois cadastrar -> 200 e `usado_em`
  preenchido; tentar cadastrar de novo com o mesmo e-mail -> 409 (regra ja
  existente, nao a allowlist); `DELETE` remove um ainda nao usado; rotas
  `/plataforma/emails-liberados/*` exigem admin da plataforma (403 pra
  quem nao e).
- **Regressao completa:** roda com `SIGNUP_ALLOWLIST_DISABLED=1` no
  servidor local, exatamente como ja acontece com `RATE_LIMIT_DISABLED=1`
  — **nenhum arquivo de teste existente precisa mudar**, ao contrario do
  que aconteceu no B2 (onde tirar o seed automatico quebrou a suposicao de
  6 suites). Aqui o bypass e a nivel de variavel de ambiente, nao de dado
  semeado.

## 7. Fora de escopo (registrado, nao descartado)

- Revogar acesso de empresa ja cadastrada — ja resolvido pelo bloqueio
  existente (`empresas.ativo`).
- Convite por link/token — descartado nesta rodada por dar mais trabalho
  operacional ao dono do que a allowlist simples.
- Expirar uma liberacao nao usada apos X dias — nao pedido, YAGNI.
