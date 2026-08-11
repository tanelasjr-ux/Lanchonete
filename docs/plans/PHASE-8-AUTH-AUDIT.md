# Fase 8 — Auditoria de Autenticação (JWT local → Supabase Auth)

Auditoria **antes** de qualquer código de Supabase Auth, conforme pendência
registrada desde a Fase 1. Este documento não implementa a migração: mapeia o
mecanismo atual, responde com **fatos verificados** (não suposições) as
perguntas que definem a estratégia, e apresenta a recomendação para decisão do
dono do projeto.

Tudo que aparece como "verificado" abaixo foi testado contra o **projeto
Supabase real**, com usuários de sonda criados e apagados em seguida
(`auth.users` ficou em 0 ao fim).

---

## 1. Como a autenticação funciona hoje

### 1.1 Senha

`crypto.scryptSync` com os parâmetros **padrão do Node** (N=16384, r=8, p=1),
chave de 64 bytes, salt aleatório de 16 bytes. Persistido em
`usuarios.senha_hash` no formato `salt_hex:hash_hex` (161 caracteres). Custo
medido: ~60 ms por verificação.

### 1.2 Token

JWT HS256 assinado manualmente (sem biblioteca), TTL de 7 dias, entregue no
login/registro e enviado como `Authorization: Bearer`. **Não há refresh token
nem mecanismo de revogação** — um token vazado vale 7 dias.

### 1.3 O portão de autenticação

Existe **um único ponto** onde tudo passa (`route.js`, logo após os webhooks
públicos):

```js
const session = await auth(request)                    // valida o JWT
if (!session) return err('Nao autorizado', 401)
const usuario = await usuarioRepo.findById(session.empresa_id, session.usuario_id)
if (!usuario || !usuario.ativo) return err('Sessao invalida', 401)
const ctx = { empresa_id: session.empresa_id, usuario_id: session.usuario_id,
              nome: usuario.nome, papel: usuario.papel }   // <- papel do BANCO
```

**Propriedade mais importante desta arquitetura, e que facilita muito a
migração:** o token carrega `papel`, mas **ninguém o lê para autorizar**. O
`ctx.papel` usado pelas 50 checagens `can(ctx.papel, modulo)` vem sempre do
banco, relido a cada requisição. Consequências práticas:

- Revogar acesso é **imediato** (basta `ativo=false` ou trocar o papel) — não
  se espera o token expirar.
- **O RBAC não precisa virar claim de token** na migração. Menos superfície de
  ataque e nada para invalidar.

Do token, portanto, só se aproveita a **identidade**: `usuario_id` +
`empresa_id`. E o par é validado em conjunto — um token com combinação
inexistente não encontra usuário e cai em 401.

### 1.4 RBAC

Hardcoded em `ROLES`/`PERMISSIONS` no `route.js` (5 papéis, 50 checagens). As
tabelas `papeis`/`permissoes` existem no banco com seed, mas **o app não as
lê** — armadilha já conhecida, fora do escopo desta fase.

### 1.5 Frontend

`app/page.js`: `fetch` puro, token em `localStorage['ros_token']`, header
`Bearer` montado a cada chamada. **Não decodifica o token e não tem nenhuma
lógica de refresh** — vive assumindo que o token dura 7 dias.

---

## 2. Vulnerabilidades encontradas e JÁ CORRIGIDAS nesta auditoria

Três problemas reais no código de autenticação, corrigidos dentro do escopo
desta fase (`CLAUDE.md` §9 manda corrigir vulnerabilidade encontrada durante a
tarefa). Regressão completa executada depois, nos dois backends.

### 2.1 `JWT_SECRET` tinha fallback público e versionado

```js
const JWT_SECRET = process.env.JWT_SECRET || 'ros_dev_secret'   // ANTES
```

Se a variável faltasse em produção, o sistema subia normalmente assinando
tokens com um segredo **que está no código-fonte** — qualquer pessoa com
acesso ao repositório poderia forjar um token válido para qualquer empresa e
qualquer usuário. Falha silenciosa: nada no log indicaria o problema.

**Corrigido**: em produção (`NODE_ENV=production`) a ausência de `JWT_SECRET`
agora **derruba o boot** com erro explícito. Em desenvolvimento mantém um
default local, com nome que deixa claro o que é.

### 2.2 `exp` gravado em milissegundos (fora do padrão JWT)

```js
exp: Date.now() + TOKEN_TTL_MS   // ANTES: ~1.787e12
```

A RFC 7519 define `exp` como *NumericDate* — **segundos** desde a época. O
código era internamente coerente (assinava e validava em ms), então funcionava.
Mas qualquer biblioteca JWT padrão — **incluindo a do Supabase**, que entra em
cena justamente na migração — leria `1.787e12` como segundos e concluiria que o
token expira no **ano ~58600**, ou seja, nunca.

**Corrigido**: `iat`/`exp` agora em segundos. A validação aceita os dois
formatos durante a transição (valor acima de ~1e11 só pode ser ms), então
**nenhuma sessão ativa foi invalidada**.

### 2.3 Comparação de assinatura vulnerável a timing

```js
if (sig !== expected) return null   // ANTES
```

Comparação de string em JavaScript retorna no primeiro caractere diferente. A
diferença de tempo é pequena, mas mensurável em volume, e vaza quantos
caracteres iniciais da assinatura estão corretos — permitindo, em teoria,
construir uma assinatura válida byte a byte.

**Corrigido**: `crypto.timingSafeEqual`, com checagem de comprimento antes
(a função lança exceção se os buffers tiverem tamanhos diferentes).

---

## 3. Fatos verificados sobre o Supabase Auth

Sondados contra o projeto real, porque cada um deles muda a estratégia:

| # | Pergunta | Resposta verificada |
|---|---|---|
| 1 | `admin.createUser()` aceita `id` escolhido por nós? | **SIM** — o `id` é respeitado, e o `sub` do JWT emitido no login é exatamente ele |
| 2 | `app_metadata` aceita claims customizadas? | **SIM** — gravadas e presentes no JWT (e, ao contrário de `user_metadata`, **não editáveis pelo usuário**) |
| 3 | Formato nativo do hash de senha | **bcrypt** (`$2a$10$…`, 60 chars) |
| 4 | Formato do token emitido | `exp` em **segundos**, validade de **1 hora**, com **refresh token**, `role: authenticated` |

O fato nº 1 é o mais importante de toda a auditoria — ver §4.1.

---

## 4. As quatro decisões de projeto

### 4.1 Identidade: `auth.users.id` = `usuarios.id`

As funções que sustentam o RLS assumem essa igualdade:

```sql
create function public.current_empresa_id() returns uuid as $$
  select empresa_id from public.usuarios where id = auth.uid();
$$;
```

Havia duas saídas: (a) forçar `auth.users.id` a ser igual ao `usuarios.id` já
existente, ou (b) adicionar uma coluna de mapeamento `usuarios.auth_user_id` e
reescrever as funções.

**Como o fato nº 1 confirmou que a Admin API respeita um `id` escolhido, a
opção (a) é viável e é claramente superior:** zero mudança de schema, zero
mudança nas funções RLS, zero reescrita de dado.

O caminho oposto — deixar o Supabase gerar novos IDs e reapontar tudo — seria
destrutivo. `usuarios.id` é referenciado por:

| Origem | Coluna | Ao apagar |
|---|---|---|
| `comandas` | `operador_id` | SET NULL |
| `comanda_itens` | `operador_id` | SET NULL |
| `conversas` | `operador_id` | SET NULL |
| `mensagens` | `operador_id` | SET NULL |

E, sem FK nenhuma, `auditoria.usuario_id` guarda **78 IDs distintos** — a
trilha de auditoria inteira. Trocar os IDs anularia as quatro colunas acima
(`SET NULL`, silenciosamente) e **órfãaria toda a auditoria histórica**, sem
erro algum aparecer.

> **Regra que sai daqui:** `usuarios.id` é imutável. Qualquer plano de
> autenticação que exija trocá-lo deve ser descartado.

### 4.2 Senhas: migração preguiçosa (lazy), no login

O hash local é scrypt em formato próprio; o GoTrue armazena bcrypt e não
importa esse formato. **Não existe caminho de importação** — e como só
guardamos hash, não há como gerar o bcrypt sem a senha em texto claro.

Três opções:

| Opção | Custo para o usuário | Avaliação |
|---|---|---|
| **A.** Reset de senha em massa (79 usuários) | Todos precisam redefinir; exige e-mail funcionando | Disruptivo e visível; não recomendado como plano principal |
| **B.** Migração lazy no login | **Nenhum** — transparente | **Recomendada** |
| **C.** Manter auth local para sempre | Nenhum | Abre mão de Supabase Auth (e do RLS real) |

**Como funciona a opção B:** no login, a senha em texto claro está disponível
por um instante. Então:

1. Verifica com o scrypt local, como hoje.
2. Se OK **e** o usuário ainda não existe no `auth.users`: cria via
   `admin.createUser({ id: usuarios.id, email, password: <a senha digitada>, email_confirm: true })`.
3. Marca o usuário como migrado e passa a autenticar por Supabase Auth.

O usuário não percebe nada. Depois de um prazo (ex.: 90 dias), quem nunca
logou recebe reset — população pequena e conhecida, dá para tratar caso a caso.

**Requisito:** durante a janela de convivência, os dois mecanismos coexistem.
Isso precisa de um marcador explícito por usuário (ex.: `usuarios.auth_migrado`)
para não haver ambiguidade sobre qual caminho vale.

### 4.3 RLS: **não** acoplar à migração de Auth

Situação atual, que é fácil interpretar errado: a aplicação usa a
`service_role`, que **ignora RLS por completo**. Hoje o isolamento entre
empresas é 100% da camada de aplicação; as 18 policies são defesa em
profundidade que **nunca é exercida** em runtime.

Migrar para Supabase Auth **não liga o RLS sozinho** — para isso seria preciso
passar a fazer as requisições com o token do usuário, e não com a service_role.
Isso é uma segunda mudança, independente e mais arriscada: se qualquer policy
estiver incompleta, o sintoma é dado sumindo da tela.

**Recomendação: separar.** Fase de Auth troca só o mecanismo de identidade,
mantendo `service_role`. "Fazer o RLS valer de verdade" vira fase própria, com
teste de isolamento por policy. Juntar as duas seria misturar dois riscos e não
saber qual quebrou.

### 4.4 Claims: manter `papel` vindo do banco

Como o §1.3 mostrou, hoje o papel nunca é lido do token. **Manter assim.**
Colocar `papel` no `app_metadata` traria um problema que hoje não existe: a
claim fica congelada dentro do token até ele expirar — rebaixar um GERENTE para
ATENDENTE só teria efeito até 1 hora depois. Ler do banco custa uma consulta
que **já acontece de qualquer forma** (o `usuarioRepo.findById` do portão).

`app_metadata` só passa a ser necessário se/quando o RLS for realmente ligado
(§4.3) — e mesmo aí, `current_empresa_id()` resolve por consulta ao banco.

---

## 5. Impacto no frontend (o mais subestimado)

| Hoje | Com Supabase Auth |
|---|---|
| Token de **7 dias** | Access token de **1 hora** + refresh token |
| Sem refresh | Refresh obrigatório |
| `localStorage['ros_token']`, `fetch` puro | Precisa de gestão de sessão |

**Sem tratar isso, todo usuário é deslogado após 1 hora de uso.** O frontend
atual não tem nenhuma lógica de renovação — `app/page.js` só lê a string do
`localStorage` e monta o header.

Dois caminhos: adotar o cliente `supabase-js` no frontend (faz refresh
sozinho, mas muda o padrão de chamada em toda a aplicação) ou implementar
refresh manual no wrapper `api()`, que é o ponto único por onde toda chamada
já passa — bem menos invasivo.

Este é o item que mais justifica ter validação E2E de navegador antes do corte:
é exatamente o tipo de quebra que passa em teste de API e falha com usuário
real, uma hora depois do login.

---

## 6. Riscos

1. **E-mail único global.** `usuarios.email` é UNIQUE no schema e o Supabase
   Auth também exige e-mail único por projeto — alinhados. Mas isso confirma
   uma limitação de produto já existente: **a mesma pessoa não pode ser usuária
   de duas empresas com o mesmo e-mail**. Vale decidir conscientemente se é
   aceitável antes de amarrar a um segundo sistema.
2. **Dependência externa no caminho crítico.** Hoje o login funciona com o
   banco de pé. Depois, uma indisponibilidade do serviço de Auth do Supabase
   derruba o login inteiro — inclusive com o Mongo como runtime.
3. **Convivência de dois mecanismos** durante a migração lazy: é o período de
   maior risco de comportamento ambíguo. Precisa do marcador do §4.2 e de teste
   cobrindo os dois caminhos.
4. **Rollback.** O plano precisa manter `senha_hash` intacto até a migração ser
   declarada concluída. Apagar o hash local cedo demais elimina a volta.

---

## 7. Recomendação

**Fazer a migração, na ordem abaixo, e não antes do corte de produção do banco.**

Motivo da ordem: hoje o runtime ainda é MongoDB. Migrar Auth agora significaria
manter identidade no Supabase e dados no Mongo — uma configuração híbrida sem
ganho real, mas com risco novo.

```
1. Corte de produção do banco (Supabase como runtime)   <- decisão do dono
2. Migração de Auth (esta fase), com:
   2.1 coluna `usuarios.auth_migrado`
   2.2 login com verificação dupla (scrypt local -> cria no Supabase Auth)
   2.3 refresh de token no wrapper api() do frontend
   2.4 E2E de navegador cobrindo sessão > 1h
3. Fase separada: fazer o RLS valer (trocar service_role por token de usuário)
4. Prazo para reset dos usuários que nunca logaram
```

**O que NÃO fazer:** trocar `usuarios.id`; colocar `papel` em claim de token;
juntar Auth e RLS na mesma fase; apagar `senha_hash` antes do fim.

---

## 8. Estado após esta auditoria

- **Nada de Supabase Auth foi implementado** — só análise, conforme o combinado.
- **Três vulnerabilidades reais corrigidas** (§2), com regressão completa:

| Suíte | MongoDB | Supabase |
|---|---|---|
| v1 | 40/40 | 40/40 |
| v2 | 39/39 | 39/39 |
| v3 | 32/33 | 32/33 |

(A falha do v3 é a mesma dos dois lados: o não-bug já documentado do
`tipo:'conversation'` da Evolution API.)

- Sondas de teste no Supabase criadas e **apagadas**; `auth.users` em 0.
