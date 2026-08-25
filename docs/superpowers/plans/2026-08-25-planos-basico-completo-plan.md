# Planos Básico e Completo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Segmentar o Restaurant OS em dois planos comerciais (Básico e Completo), amarrando o conceito ao sistema de módulos que já existe, sem tirar acesso de quem já usa um módulo hoje.

**Architecture:** O campo `assinaturas.plano` já existe (texto livre, nunca lido) — vira um enum de 2 valores. Uma cópia de leitura (`empresa.config.plano`) é sincronizada toda vez que a assinatura muda, para que `temModulo()` continue síncrona e com a mesma assinatura de função. Uma tabela nova em `lib/modulos.js` (`PLANO_MODULOS`) declara quais módulos cada plano inclui; `Estoque`, `Caixa` e um módulo novo `Financeiro` passam a exigir o plano Completo. Mesas/balcão/delivery nunca são restringidos por plano.

**Tech Stack:** Next.js API routes, Postgres/Supabase (produção) + Mongo (dev local), pytest para testes de integração, scripts `.mjs` para testes puros.

**Spec:** `docs/superpowers/specs/2026-08-25-planos-basico-completo-design.md`

## Global Constraints

- Nunca tirar acesso de quem já usa um módulo — a Tanelas FooD (única empresa real em produção) migra direto pra `completo` na mesma migration que trava o enum, antes do gate valer.
- `temModulo(empresa, modulo)` continua síncrona e com a mesma assinatura — nenhuma rota que já a chama (ou chama `exigeModulo`) muda de forma.
- Downgrade de plano nunca apaga dado.
- `empresa.plano` (campo legado top-level, hoje hardcoded `'free'` no signup) nunca é lido nem escrito por este plano — a fonte de verdade é `assinaturas.plano` / `empresa.config.plano`.
- Mercado Pago e qualquer integração externa nunca são mockados (regra já existente do projeto) — não se aplica diretamente a este plano (nenhuma task chama gateway externo), mas vale registrar porque nenhuma task deve simular sucesso de nada.
- Migrations SQL testadas em transação com `ROLLBACK` contra produção antes de aplicar (disciplina já estabelecida no projeto — não há staging).
- Ao editar `app/api/[[...path]]/route.js`, nunca confiar cegamente em números de linha citados neste plano — as tasks anteriores deslocam linhas. Localizar pelo texto exato (`old_string`), não pela posição.

---

### Task 1: `lib/modulos.js` — plano vira uma segunda camada de decisão

**Files:**
- Modify: `lib/modulos.js`
- Create: `test_modulos_planos.mjs` (raiz do projeto — mesmo padrão de `test_point_calculo.mjs`/`test_assinatura_calculo.mjs`, teste puro sem servidor)

**Interfaces:**
- Produces: `planoInclui(empresa, modulo): boolean` (exportada — Task 5 e Task 6 a consomem), `PLANO_MODULOS: { basico: string[], completo: string[] }` (exportada), `MODULOS.financeiro` (nova entrada no catálogo existente)
- Consumes: nada de outras tasks (fundação)

- [ ] **Step 1: Escrever o teste que falha**

Criar `test_modulos_planos.mjs`:

```js
import assert from 'node:assert/strict'
import { planoInclui, temModulo, PLANO_MODULOS, MODULOS } from './lib/modulos.js'

let passou = 0
function teste(nome, fn) {
  try { fn(); console.log(`PASS: ${nome}`); passou++ }
  catch (e) { console.error(`FAIL: ${nome}\n   ${e.message}`); process.exitCode = 1 }
}

teste('financeiro entra no catalogo de modulos', () => {
  assert.ok(MODULOS.financeiro, 'MODULOS.financeiro precisa existir')
  assert.deepEqual(MODULOS.financeiro.flags, ['financeiro'])
})

teste('PLANO_MODULOS: basico nao inclui nada restrito, completo inclui estoque/caixa/financeiro', () => {
  assert.deepEqual(PLANO_MODULOS.basico, [])
  assert.deepEqual(PLANO_MODULOS.completo.sort(), ['caixa', 'estoque', 'financeiro'].sort())
})

teste('planoInclui: modulo fora de PLANO_MODULOS nunca e restringido (mesas)', () => {
  assert.equal(planoInclui({ config: { plano: 'basico' } }, 'mesas'), true)
  assert.equal(planoInclui({ config: {} }, 'mesas'), true)
})

teste('planoInclui: empresa basico NAO inclui estoque/caixa/financeiro', () => {
  const empresa = { config: { plano: 'basico' } }
  assert.equal(planoInclui(empresa, 'estoque'), false)
  assert.equal(planoInclui(empresa, 'caixa'), false)
  assert.equal(planoInclui(empresa, 'financeiro'), false)
})

teste('planoInclui: empresa completo inclui estoque/caixa/financeiro', () => {
  const empresa = { config: { plano: 'completo' } }
  assert.equal(planoInclui(empresa, 'estoque'), true)
  assert.equal(planoInclui(empresa, 'caixa'), true)
  assert.equal(planoInclui(empresa, 'financeiro'), true)
})

teste('planoInclui: config.plano ausente conta como basico (nunca completo por omissao)', () => {
  assert.equal(planoInclui({ config: {} }, 'estoque'), false)
  assert.equal(planoInclui({}, 'estoque'), false)
})

teste('temModulo: plano basico bloqueia estoque mesmo com a flag ligada', () => {
  const empresa = { config: { plano: 'basico', feature_flags: { estoque: true } } }
  assert.equal(temModulo(empresa, 'estoque'), false, 'plano deve vencer antes da flag ser consultada')
})

teste('temModulo: plano completo + flag desligada continua bloqueado (as duas camadas valem)', () => {
  const empresa = { config: { plano: 'completo', feature_flags: { estoque: false } } }
  assert.equal(temModulo(empresa, 'estoque'), false)
})

teste('temModulo: plano completo + flag ligada libera', () => {
  const empresa = { config: { plano: 'completo', feature_flags: { estoque: true } } }
  assert.equal(temModulo(empresa, 'estoque'), true)
})

teste('temModulo: mesas continua imune a plano, so a flag decide', () => {
  assert.equal(temModulo({ config: { plano: 'basico', feature_flags: { mesas: true } } }, 'mesas'), true)
  assert.equal(temModulo({ config: { plano: 'basico', feature_flags: { mesas: false } } }, 'mesas'), false)
})

console.log(`\n${passou}/11 testes passaram`)
if (passou < 11) process.exit(1)
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
node test_modulos_planos.mjs
```

Expected: `FAIL` em quase todos — `planoInclui`, `PLANO_MODULOS` e `MODULOS.financeiro` ainda não existem (import quebra o arquivo inteiro).

- [ ] **Step 3: Implementar em `lib/modulos.js`**

Adicionar `financeiro` ao objeto `MODULOS` (logo após a entrada `caixa`, mantendo o mesmo formato):

```js
  financeiro: {
    label: 'Financeiro',
    descricao: 'DRE, comparativo de periodo, margem por canal/produto, contas a pagar e receber.',
    flags: ['financeiro'],
  },
```

Adicionar, logo após a definição de `MODULOS_EM_BREVE`:

```js
/**
 * Quais modulos cada PLANO comercial inclui. Modulo que nao aparece em
 * nenhuma lista aqui (mesas, balcao, delivery — nunca tiveram flag de
 * plano) nunca e restringido por plano, so pela flag individual da
 * empresa (`temModulo`). Ver spec 2026-08-25 — nenhum concorrente do
 * mercado corta plano por canal de venda, so por profundidade de gestao.
 */
export const PLANO_MODULOS = {
  basico: [],
  completo: ['estoque', 'caixa', 'financeiro'],
}

/**
 * O plano contratado permite este modulo? Isolada de `temModulo` porque
 * `PUT /modulos/:chave` (route.js) precisa da MESMA decisao sem a parte
 * de flags, pra travar "ligar" antes de tocar em feature_flags.
 *
 * REGRA CRITICA (mesma direcao de `temModulo`, mas invertida): ausencia
 * de `config.plano` conta como 'basico', NUNCA como 'completo' — falta de
 * informacao sobre o que a empresa contratou nao pode liberar o nivel
 * mais alto por omissao.
 */
export function planoInclui(empresa, modulo) {
  const exigePlano = Object.values(PLANO_MODULOS).flat().includes(modulo)
  if (!exigePlano) return true
  const plano = empresa?.config?.plano || 'basico'
  return (PLANO_MODULOS[plano] || []).includes(modulo)
}
```

Substituir a função `temModulo` existente por:

```js
export function temModulo(empresa, modulo) {
  if (!planoInclui(empresa, modulo)) return false
  const flags = empresa?.config?.feature_flags
  if (!flags) return true
  return flags[modulo] !== false
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
node test_modulos_planos.mjs
```

Expected: `11/11 testes passaram`

- [ ] **Step 5: Commit**

```bash
git add lib/modulos.js test_modulos_planos.mjs
git commit -m "feat(planos): PLANO_MODULOS + planoInclui() + modulo financeiro"
```

---

### Task 2: Migration — trava o enum de `assinaturas.plano` e migra a Tanelas FooD

**Files:**
- Create: `supabase/migrations/00XX_planos_basico_completo.sql` (usar o próximo número sequencial real — checar o último arquivo em `supabase/migrations/` antes de nomear)

**Interfaces:**
- Consumes: nada de código (SQL puro)
- Produces: `assinaturas.plano` passa a aceitar só `'basico'`/`'completo'`; a empresa `Tanelas FooD` fica com assinatura em `'completo'` e `empresas.config.plano = 'completo'`

- [ ] **Step 1: Escrever a migration**

```sql
-- ============================================================================
-- Restaurant OS :: Migration 00XX :: Planos Basico e Completo
-- ============================================================================
-- `assinaturas.plano` existe desde a migration 0027 mas sempre foi texto
-- livre, nunca lido por nenhuma logica de gate (mesmo padrao do bug que
-- motivou a feature de modulos, B1). Esta migration trava o campo num enum
-- de 2 valores e, na MESMA transacao, garante que a unica empresa real em
-- producao (Tanelas FooD) nao perca acesso a Estoque/Caixa, que ja usa
-- ativamente hoje — mesma disciplina da migration 0023 (nunca tirar acesso
-- de quem ja usa).

alter table public.assinaturas
  add constraint assinaturas_plano_valido check (plano in ('basico', 'completo'));

-- Cria a assinatura da Tanelas FooD se ainda nao existir (hoje a tabela
-- assinaturas esta vazia para ela — nunca foi configurada pelo Painel
-- ETNA). Valor e vencimento sao provisorios: so o PLANO precisa estar
-- certo no instante em que o gate entrar no ar; o dono ajusta valor real
-- depois, sem pressa, pelo Painel.
insert into public.assinaturas (id, empresa_id, plano, valor, dia_vencimento, proximo_vencimento, status, observacoes)
select gen_random_uuid(), e.id, 'completo', 0, 10, (current_date + interval '30 days')::date, 'ativa',
       'Migrada automaticamente para completo na migration 00XX — ja usava Estoque/Caixa antes de existir plano formal.'
from public.empresas e
where e.nome = 'Tanelas FooD'
  and not exists (select 1 from public.assinaturas a where a.empresa_id = e.id);

-- Espelha o plano em empresas.config (mesmo campo que temModulo() vai ler)
-- para a Tanelas FooD especificamente, ja que o codigo que sincroniza isso
-- automaticamente (Task 4) so entra em vigor a partir do proximo deploy.
update public.empresas
set config = jsonb_set(coalesce(config, '{}'::jsonb), '{plano}', '"completo"'::jsonb)
where nome = 'Tanelas FooD';
```

- [ ] **Step 2: Testar em transação com rollback contra produção**

```bash
docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL" -c "
BEGIN;
$(cat supabase/migrations/00XX_planos_basico_completo.sql)
SELECT nome, config->>'plano' AS plano_config FROM empresas WHERE nome = 'Tanelas FooD';
SELECT plano, status FROM assinaturas WHERE empresa_id = (SELECT id FROM empresas WHERE nome = 'Tanelas FooD');
ROLLBACK;
"
```

Expected: os dois `SELECT` mostram `plano_config = 'completo'` e `plano = 'completo', status = 'ativa'`, depois `ROLLBACK` confirmado. Se a tabela `assinaturas` tiver alguma linha com `plano` fora de `'basico'`/`'completo'` hoje (improvável, mas o campo sempre foi texto livre), o `ALTER TABLE ... ADD CONSTRAINT` vai falhar aqui dentro da transação — reportar como BLOCKED se acontecer, não decidir sozinho o que fazer com dado sujo em produção.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00XX_planos_basico_completo.sql
git commit -m "feat(planos): migration trava enum de assinaturas.plano + migra Tanelas FooD para completo"
```

A migration só aplica de verdade em produção no próximo deploy automático (boot do container roda `scripts/migrate.mjs`) — não requer nenhum passo manual além do commit.

---

### Task 3: `POST /auth/register` cria a assinatura automaticamente

**Files:**
- Modify: `app/api/[[...path]]/route.js` (rota `POST /auth/register`)
- Test: `tests/backend_test_modulos.py` (adicionar caso)

**Interfaces:**
- Consumes: `assinaturaRepo.create(entity)` (repository já existente, mesma forma usada em `PUT /plataforma/empresas/:id/assinatura`)
- Produces: toda empresa nova nasce com uma linha em `assinaturas` (`plano: 'basico'`) e `empresa.config.plano = 'basico'`

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `tests/backend_test_modulos.py`, antes de `if __name__ == '__main__':`:

```python
def test_signup_cria_assinatura_automatica_no_basico():
    """Empresa nova nasce com uma assinatura formal (plano basico), nao no limbo.

    Antes desta mudanca, `assinaturas` ficava vazia ate o dono da ETNA
    configurar manualmente pelo Painel — a empresa existia sem nenhum
    registro de plano.
    """
    headers = criar_empresa("Signup Assinatura")
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    assert empresa["config"]["plano"] == "basico", "config.plano deveria nascer 'basico'"


def test_signup_nasce_basico_estoque_e_caixa_bloqueados():
    """Mudanca de comportamento INTENCIONAL: com plano formal, uma empresa
    nova nasce no Basico, entao Estoque/Caixa (que exigem Completo) vem
    BLOQUEADOS mesmo com a flag ligada — nao mais liberados por padrao.
    """
    headers = criar_empresa("Signup Basico Bloqueado")
    r = requests.get(f"{BASE_URL}/modulos", headers=headers)
    ativos = {m["chave"]: m["ativo"] for m in r.json()["disponiveis"]}
    assert ativos["estoque"] is False, "Basico nao inclui Estoque"
    assert ativos["caixa"] is False, "Basico nao inclui Caixa"
    assert ativos["financeiro"] is False, "Basico nao inclui Financeiro"
    assert ativos["mesas"] is True, "Mesas nunca e restringido por plano"
```

- [ ] **Step 2: Rodar e confirmar que falha**

Servidor local rodando (`RATE_LIMIT_DISABLED=1 SIGNUP_ALLOWLIST_DISABLED=1 yarn dev:no-reload`):

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_signup_cria_assinatura_automatica_no_basico tests/backend_test_modulos.py::test_signup_nasce_basico_estoque_e_caixa_bloqueados -v
```

Expected: `test_signup_cria_assinatura_automatica_no_basico` FALHA com `KeyError: 'plano'` (config ainda não tem essa chave). `test_signup_nasce_basico_estoque_e_caixa_bloqueados` também FALHA — hoje `estoque`/`caixa` nascem `True` (comportamento antigo, sem plano nenhum consultado ainda nesta task).

- [ ] **Step 3: Implementar**

Em `app/api/[[...path]]/route.js`, rota `POST /auth/register`: dentro do objeto `config` que a empresa nova recebe (procurar `feature_flags: flagsPadraoSignup(),`), adicionar a chave `plano`:

```js
        config: {
          feature_flags: flagsPadraoSignup(),
          plano: 'basico',
          appearance: { cor_principal: '#4f46e5', cor_secundaria: '#7c3aed', tema: 'light', nome_exibido: empresa_nome },
          pagamentos: { metodos: { dinheiro: true, pix: true, cartao_debito: true, cartao_credito: true }, taxa_servico_padrao: 10 },
        },
```

Logo depois de `await empresaRepo.create(empresa)` (mesma função, antes de criar o `usuario`), criar a assinatura:

```js
      const assinaturaId = uuidv4()
      const vencimentoInicial = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      await assinaturaRepo.create({
        id: assinaturaId, empresa_id, plano: 'basico', valor: 0, dia_vencimento: 10,
        proximo_vencimento: vencimentoInicial, status: 'ativa', ultimo_pagamento_em: null,
        observacoes: 'Criada automaticamente no cadastro — ajustar valor real pelo Painel ETNA.',
        created_at: new Date(), updated_at: new Date(),
      })
```

`assinaturaRepo` já está disponível no escopo do handler (mesmo `repos` desestruturado usado em `PUT /plataforma/empresas/:id/assinatura`) — confirmar que está na lista de repositories desestruturados no topo da função `handler`; se não estiver, adicionar `assinaturaRepo` à desestruturação existente.

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_signup_cria_assinatura_automatica_no_basico tests/backend_test_modulos.py::test_signup_nasce_basico_estoque_e_caixa_bloqueados -v
```

Expected: `2 passed`

- [ ] **Step 5: Commit**

```bash
git add "app/api/[[...path]]/route.js" tests/backend_test_modulos.py
git commit -m "feat(planos): signup cria assinatura automatica no plano basico"
```

---

### Task 4: `PUT /plataforma/empresas/:id/assinatura` sincroniza `config.plano`

**Files:**
- Modify: `app/api/[[...path]]/route.js` (rota `PUT /plataforma/empresas/:id/assinatura`)
- Test: `tests/backend_test_plataforma.py` (adicionar caso)

**Interfaces:**
- Consumes: `salva.plano` (retorno de `assinaturaRepo.create`/`update`, já existente)
- Produces: toda vez que o admin edita a assinatura de uma empresa, `empresa.config.plano` reflete o novo plano na mesma requisição

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `tests/backend_test_plataforma.py`, antes de `if __name__ == '__main__':` (reaproveitar os helpers `criar_empresa`/`promover_admin` já existentes no arquivo):

```python
def test_configurar_assinatura_sincroniza_plano_na_empresa():
    """Trocar o plano pelo Painel ETNA precisa refletir em config.plano —
    e' o campo que temModulo() consulta de verdade. Sem sincronizar, o
    admin muda o plano na tela e nada acontece de fato no acesso.
    """
    admin = criar_empresa("Admin Sincroniza Plano")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Sincroniza Plano")

    r = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"plano": "completo", "valor": 200, "dia_vencimento": 10, "proximo_vencimento": "2026-12-01"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["plano"] == "completo"

    empresa = requests.get(f"{BASE_URL}/empresa", headers=cliente["headers"]).json()
    assert empresa["config"]["plano"] == "completo", "config.plano deveria ter sido sincronizado"

    ativos = {m["chave"]: m["ativo"] for m in requests.get(f"{BASE_URL}/modulos", headers=cliente["headers"]).json()["disponiveis"]}
    assert ativos["estoque"] is True, "apos virar completo, estoque deve liberar (flag ja nascia True no signup)"
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_plataforma.py::test_configurar_assinatura_sincroniza_plano_na_empresa -v
```

Expected: FALHA em `assert empresa["config"]["plano"] == "completo"` — `config.plano` continua `'basico'` (nada sincroniza ainda).

- [ ] **Step 3: Implementar**

Em `app/api/[[...path]]/route.js`, rota `PUT /plataforma/empresas/:id/assinatura`: logo após a linha que grava `salva` (tanto no branch `if (existente)` quanto no `else` — ambos terminam antes da chamada a `auditoriaRepo.registrar`), sincronizar `config.plano`:

```js
      const configAtual = { ...(empresaAlvo.config || {}) }
      configAtual.plano = salva.plano
      await empresaRepo.update(empresaId, { config: configAtual })
```

Inserir essa chamada depois do bloco `if (existente) { ... } else { ... }` e antes de `await auditoriaRepo.registrar(...)`.

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_plataforma.py::test_configurar_assinatura_sincroniza_plano_na_empresa -v
```

Expected: `1 passed`

- [ ] **Step 5: Commit**

```bash
git add "app/api/[[...path]]/route.js" tests/backend_test_plataforma.py
git commit -m "feat(planos): PUT assinatura sincroniza empresa.config.plano"
```

---

### Task 5: `PUT /modulos/:chave` — trava de ligar fora do plano

**Files:**
- Modify: `app/api/[[...path]]/route.js` (rota `PUT /modulos/:chave` e a variante admin `PUT /plataforma/empresas/:id/modulos/:chave`)
- Test: `tests/backend_test_modulos.py` (adicionar casos)

**Interfaces:**
- Consumes: `planoInclui(empresa, modulo)` (Task 1)
- Produces: nenhuma nova, só reforça o contrato já existente da rota (agora pode devolver 403 também por motivo de plano, não só de papel)

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `tests/backend_test_modulos.py`, antes de `if __name__ == '__main__':`:

```python
def test_basico_nao_liga_estoque_pelo_toggle():
    """Dono no plano Basico tenta ligar Estoque pelo interruptor -> 403.

    Desligar continua sempre livre — so LIGAR fora do plano e' bloqueado.
    """
    headers = criar_empresa("Basico Nao Liga Estoque")
    # Estoque ja nasce desligado no plano Basico (Task 3) — confirma o
    # estado de partida antes de tentar ligar.
    ativos = {m["chave"]: m["ativo"] for m in requests.get(f"{BASE_URL}/modulos", headers=headers).json()["disponiveis"]}
    assert ativos["estoque"] is False

    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": True})
    assert r.status_code == 403
    assert "plano" in r.json()["error"].lower()

    # Confirma que a tentativa nao teve efeito colateral nenhum na flag.
    ativos_depois = {m["chave"]: m["ativo"] for m in requests.get(f"{BASE_URL}/modulos", headers=headers).json()["disponiveis"]}
    assert ativos_depois["estoque"] is False


def test_desligar_sempre_funciona_mesmo_fora_do_plano():
    """Basico tentando DESLIGAR um modulo que ja esta desligado (por plano)
    nao pode dar erro estranho — a acao e' um no-op seguro, nao um 403.
    """
    headers = criar_empresa("Basico Desliga Sem Erro")
    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": False})
    assert r.status_code == 200, r.text


def test_completo_liga_estoque_pelo_toggle_normalmente():
    """Empresa no Completo continua podendo ligar/desligar Estoque livremente
    — a trava e' so contra ligar algo que o plano nao cobre.
    """
    headers = criar_empresa("Completo Liga Estoque")
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    empresa_id = empresa["id"]

    admin = criar_empresa("Admin Promove Completo")
    from pymongo import MongoClient
    db = MongoClient("mongodb://localhost:27017")["restaurant_os_dev"]
    db.plataforma_admins.insert_one({"email": admin["email"], "nome": "Admin Teste", "ativo": True})
    requests.put(
        f"{BASE_URL}/plataforma/empresas/{empresa_id}/assinatura",
        headers=admin["headers"],
        json={"plano": "completo", "valor": 200, "dia_vencimento": 10, "proximo_vencimento": "2026-12-01"},
    )
    db.plataforma_admins.delete_many({"email": admin["email"]})

    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": True})
    assert r.status_code == 200, r.text
```

`admin["headers"]` e `criar_empresa` precisam devolver o dicionário com `email` além de `headers` — conferir a assinatura atual de `criar_empresa` neste arquivo (`tests/backend_test_modulos.py:15-21`, hoje devolve só `headers`) e ajustar para devolver `{"headers": ..., "email": ..., "empresa_id": ...}` como já faz `tests/backend_test_plataforma.py:23-33`, atualizando as chamadas existentes no arquivo (`headers = criar_empresa(...)` vira `conta = criar_empresa(...)`, com `conta["headers"]` nos usos — mecânico, mas toca todas as funções deste arquivo; fazer como parte deste step, não deixar para depois).

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py -v
```

Expected: os 3 testes novos falham (`test_basico_nao_liga_estoque_pelo_toggle` — hoje devolve 200, não 403; os outros dois podem já passar coincidentemente, confirmar caso a caso). Os testes já existentes no arquivo (`test_signup_liga_os_modulos_que_o_produto_entrega`, etc.) TAMBÉM devem estar falhando neste ponto por causa das Tasks 1-3 já aplicadas — não corrigir esses ainda, isso é a Task 7.

- [ ] **Step 3: Implementar**

Em `app/api/[[...path]]/route.js`, adicionar `planoInclui` à importação existente de `lib/modulos`:

```js
import { MODULOS, temModulo, flagsPadraoSignup, modulosAtivos, planoInclui } from '@/lib/modulos'
```

Na rota `PUT /modulos/:chave` (buscar `if (seg[0] === 'modulos' && seg[1] && method === 'PUT')`), logo após buscar `const empresa = await empresaRepo.findById(ctx.empresa_id)` e antes de montar `config`/`flags`:

```js
      if (b.ativo === true && !planoInclui(empresa, chave)) {
        return err(`Modulo "${mod.label}" nao incluido no plano atual — fale com a ETNA para upgrade.`, 403)
      }
```

Na variante admin (`PUT /plataforma/empresas/:id/modulos/:chave`, buscar `if (seg[0] === 'plataforma' && seg[1] === 'empresas' && seg[2] && seg[3] === 'modulos'`), logo após buscar `const empresaAlvo = await empresaRepo.findById(empresaId)` e antes de montar `config`/`flags`:

```js
      if (b.ativo === true && !planoInclui(empresaAlvo, chave)) {
        return err(`Modulo "${mod.label}" nao incluido no plano desta empresa — mude o plano primeiro.`, 403)
      }
```

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_basico_nao_liga_estoque_pelo_toggle tests/backend_test_modulos.py::test_desligar_sempre_funciona_mesmo_fora_do_plano tests/backend_test_modulos.py::test_completo_liga_estoque_pelo_toggle_normalmente -v
```

Expected: `3 passed` (rodar só estes três — os outros do arquivo ainda estão quebrados de propósito até a Task 7).

- [ ] **Step 5: Commit**

```bash
git add "app/api/[[...path]]/route.js" tests/backend_test_modulos.py
git commit -m "feat(planos): PUT /modulos trava ligar modulo fora do plano contratado"
```

---

### Task 6: Rotas financeiras exigem o módulo `financeiro`

**Files:**
- Modify: `app/api/[[...path]]/route.js` (10 rotas sob `/financeiro/*` e `/contas*`)
- Test: `tests/backend_test_modulos.py` (adicionar caso)

**Interfaces:**
- Consumes: `exigeModulo('financeiro')` (helper já existente em `route.js`, mesmo usado por `caixa` e `mesas`)
- Produces: nada de novo para outras tasks

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `tests/backend_test_modulos.py`, antes de `if __name__ == '__main__':`:

```python
def test_financeiro_desligado_bloqueia_todas_as_rotas_financeiras():
    """Mesmo padrao de test_caixa_desligado_bloqueia_todas_as_rotas_de_caixa
    — modulo desligado (por nascer no Basico) barra TODAS as rotas
    financeiras, nao so a primeira.
    """
    conta = criar_empresa("Financeiro Off")
    headers = conta["headers"]

    for metodo, rota, corpo in [
        ("GET", "/financeiro/transacoes", None),
        ("GET", "/financeiro/categorias-despesa", None),
        ("POST", "/financeiro/transacoes", {"tipo": "receita", "valor": 10}),
        ("GET", "/financeiro/resumo", None),
        ("GET", "/contas", None),
        ("POST", "/contas", {"tipo": "pagar", "descricao": "x", "categoria": "Outros", "valor": 10, "vencimento": "2026-12-01"}),
        ("GET", "/financeiro/relatorio", None),
    ]:
        r = requests.request(metodo, f"{BASE_URL}{rota}", headers=headers, json=corpo)
        assert r.status_code == 403, f"{metodo} {rota} deveria dar 403 no plano Basico, deu {r.status_code}: {r.text}"
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_financeiro_desligado_bloqueia_todas_as_rotas_financeiras -v
```

Expected: FALHA — todas as rotas ainda devolvem 200/201 (só checam `can(ctx.papel, 'financeiro')`, nenhuma checa módulo ainda).

- [ ] **Step 3: Implementar**

Em cada uma das 10 rotas abaixo, logo após a linha `if (!can(ctx.papel, 'financeiro')) return err('Sem permissao', 403)` (localizar cada uma pelo texto da rota — os números de linha abaixo são só orientação, podem já ter deslocado):

```js
      const bloqueio = await exigeModulo('financeiro'); if (bloqueio) return bloqueio
```

Rotas (buscar cada `if (route === ...)` / `if (seg[0] === 'contas' ...)` no arquivo):
1. `GET /financeiro/transacoes`
2. `GET /financeiro/categorias-despesa`
3. `POST /financeiro/transacoes`
4. `GET /financeiro/resumo`
5. `GET /contas` (`seg[0] === 'contas'` sem `seg[1]`, ou `route === '/contas'`)
6. `POST /contas`
7. `PUT /contas/:id` (`seg[0] === 'contas' && seg[1] && method === 'PUT' && !seg[2]`)
8. `PUT /contas/:id/pagar`
9. `PUT /contas/:id/cancelar`
10. `GET /financeiro/relatorio`

`GET /financeiro/categorias-despesa` — conferir se essa rota específica já tem a checagem `can(ctx.papel, 'financeiro')`; se não tiver (é uma lista estática de categorias, pode ter sido deixada aberta de propósito), inserir a checagem de módulo mesmo assim, sem adicionar a de papel (não é objetivo desta task mudar checagem de permissão, só de plano).

- [ ] **Step 4: Rodar e confirmar que passa**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_financeiro_desligado_bloqueia_todas_as_rotas_financeiras -v
```

Expected: `1 passed`

- [ ] **Step 5: Rodar a suite de financeiro existente para confirmar que nada quebrou pra empresas no Completo**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_dre.py tests/backend_test_comparativo.py tests/backend_test_margem_canal.py tests/backend_test_margem_produto.py tests/backend_test_contas.py -v 2>&1 | tail -40
```

Expected: essas suites provavelmente vão FALHAR agora, porque as empresas que elas criam nascem no Básico (Task 3) e essas rotas agora exigem o módulo Financeiro. **Isto é esperado e será corrigido na Task 7** — não tente consertar aqui, só confirme que a falha é exatamente essa (403 "Financeiro" desativado), não outra coisa.

- [ ] **Step 6: Commit**

```bash
git add "app/api/[[...path]]/route.js" tests/backend_test_modulos.py
git commit -m "feat(planos): rotas financeiras exigem o modulo financeiro (plano completo)"
```

---

### Task 7: Corrige a regressão esperada nas suites existentes

**Files:**
- Modify: `tests/backend_test_modulos.py`, `tests/backend_test_dre.py`, `tests/backend_test_comparativo.py`, `tests/backend_test_margem_canal.py`, `tests/backend_test_margem_produto.py`, `tests/backend_test_contas.py`, `tests/backend_test_custo.py`, `tests/backend_test_plataforma.py` — e qualquer outra suite que a Step 1 abaixo revelar

**Interfaces:**
- Consumes: `criar_empresa` (helper de cada arquivo de teste — pode precisar de uma variante que já promove a empresa para o plano Completo)
- Produces: nenhuma (task de correção, não de feature)

Esta é a task mais mecânica do plano: as Tasks 1-6 mudaram um comportamento de propósito (empresa nova nasce no Básico, sem Estoque/Caixa/Financeiro liberados) — todo teste que cria uma empresa via `criar_empresa()` e depois assume que Estoque, Caixa ou Financeiro estão liberados vai falhar, não porque o código está errado, mas porque o teste testa o mundo antigo.

- [ ] **Step 1: Rodar a suite completa e listar tudo que quebrou**

```bash
BASE_URL=http://localhost:3000/api python tests/run_all.py > /tmp/regressao-planos.log 2>&1
cat /tmp/regressao-planos.log
```

Confirmar antes de rodar que **nenhuma outra instância de `run_all.py` está em execução** (`ps aux | grep python`) — rodar duas cópias concorrentes contamina fixtures compartilhados entre suites (armadilha real, já aconteceu neste projeto).

- [ ] **Step 2: Corrigir `tests/backend_test_modulos.py`**

`test_signup_liga_os_modulos_que_o_produto_entrega` (linha ~36-51): a asserção `ativos["estoque"] is True` e `ativos["caixa"] is True` descrevia o mundo sem plano. Reescrever para:

```python
def test_signup_liga_os_modulos_que_o_produto_entrega():
    """Empresa nova nasce no plano Basico: mesas sempre ligada, Estoque e
    Caixa BLOQUEADOS pelo plano (nao pela flag, que continua True por
    padrao — ver test_modulo_futuro_nasce_fechado_no_signup para o
    equivalente dos modulos sem implementacao).
    """
    conta = criar_empresa("Signup Flags")
    r = requests.get(f"{BASE_URL}/modulos", headers=conta["headers"])
    assert r.status_code == 200
    ativos = {m["chave"]: m["ativo"] for m in r.json()["disponiveis"]}

    assert ativos["mesas"] is True
    assert ativos["estoque"] is False, "plano Basico nao inclui Estoque"
    assert ativos["caixa"] is False, "plano Basico nao inclui Caixa"
    assert ativos["financeiro"] is False, "plano Basico nao inclui Financeiro"
```

`test_modulo_sem_implementacao_nao_e_configuravel` (linha ~150-164): a asserção `{"mesas", "estoque", "caixa"}` precisa incluir `"financeiro"`:

```python
    assert {m["chave"] for m in catalogo["disponiveis"]} == {"mesas", "estoque", "caixa", "financeiro"}
```

Os demais testes deste arquivo que dependem de Estoque/Caixa ligados (`test_caixa_desligado_bloqueia_todas_as_rotas_de_caixa`, `test_estoque_desligado_devolve_lista_vazia_nao_403`, `test_religar_devolve_o_acesso_e_os_dados`) precisam da empresa no plano Completo antes de testar o comportamento de "ligado". Adicionar um helper no topo do arquivo (reaproveitando o padrão de manipulação direta do Mongo já usado em `tests/backend_test_plataforma.py`):

```python
from pymongo import MongoClient

_db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))[os.environ.get("DB_NAME", "restaurant_os_dev")]


def promover_completo(conta):
    """Uso so em dev local (Mongo) — mesmo espirito de promover_admin() em
    backend_test_plataforma.py. So prova algo contra DATABASE_PROVIDER=mongo."""
    _db.empresas.update_one({"id": conta["empresa_id"]}, {"$set": {"config.plano": "completo"}})
```

E chamar `promover_completo(conta)` logo após `criar_empresa(...)` em cada um desses três testes, antes de qualquer asserção que espera o módulo ligado. Isso exige que `criar_empresa()` devolva `empresa_id` além de `headers`/`email` (mesmo ajuste já necessário na Task 5, Step 1 — se ainda não foi feito, fazer agora).

- [ ] **Step 3: Corrigir as suites de relatório financeiro**

`tests/backend_test_dre.py`, `tests/backend_test_comparativo.py`, `tests/backend_test_margem_canal.py`, `tests/backend_test_margem_produto.py`, `tests/backend_test_contas.py` — cada uma cria empresas via seu próprio helper `criar_empresa` local e chama rotas de `/financeiro/*`/`/contas`. Cada arquivo precisa do mesmo `promover_completo()` (copiar o helper acima para cada arquivo, ou — preferível, se o tempo permitir — mover para um módulo compartilhado `tests/_helpers_plano.py` e importar nos 6 arquivos; decidir pelo que for mais rápido de aplicar corretamente nos 6 arquivos sem quebrar imports existentes) e chamá-lo logo após criar cada empresa de teste, antes da primeira chamada a uma rota financeira.

- [ ] **Step 4: Corrigir `tests/backend_test_custo.py` e `tests/backend_test_plataforma.py` se a Step 1 os listou**

Mesmo padrão: se algum teste falhar por 403 de módulo (não por outro motivo), a causa é a mesma — empresa de teste nasceu no Básico e a rota exigida está no Completo. Aplicar `promover_completo()` (ou, para `backend_test_plataforma.py`, usar a própria rota `PUT /plataforma/empresas/:id/assinatura` já testada na Task 4, que é mais realista que escrever direto no Mongo neste arquivo específico, já que ele já manipula admin via API).

Se a Step 1 revelar falhas de motivo DIFERENTE de 403/módulo, não tentar corrigi-las aqui — reportar como achado separado (pode ser regressão real não relacionada a este plano).

- [ ] **Step 5: Rodar a suite completa de novo, limpa**

```bash
ps aux | grep python  # confirmar zero instâncias rodando antes
BASE_URL=http://localhost:3000/api python tests/run_all.py
```

Expected: todas as suites verdes, exceto `backend_test_rate_limit.py` (sempre falha com `RATE_LIMIT_DISABLED=1`, comportamento esperado documentado no projeto).

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "test(planos): corrige suites existentes para o novo default (empresa nasce no Basico)"
```

---

### Task 8: UI — Painel ETNA, campo de plano vira seletor

**Files:**
- Modify: `app/page.js` (dialog "Configurar assinatura" do Painel ETNA)

**Interfaces:**
- Consumes: `PUT /plataforma/empresas/:id/assinatura` (já existente, aceita `plano` no corpo — Task 4 não mudou o contrato de entrada)
- Produces: nada de novo para outras tasks

- [ ] **Step 1: Localizar o campo atual**

Buscar por `<Input value={f.plano}` em `app/page.js` (hoje um campo de texto livre, placeholder "básico").

- [ ] **Step 2: Substituir por um `<Select>`**

Trocar:

```jsx
<Input value={f.plano} onChange={(e) => setF((s) => ({ ...s, plano: e.target.value }))} placeholder="básico" />
```

Por:

```jsx
<Select value={f.plano} onValueChange={(v) => setF((s) => ({ ...s, plano: v }))}>
  <SelectTrigger><SelectValue /></SelectTrigger>
  <SelectContent>
    <SelectItem value="basico">Básico</SelectItem>
    <SelectItem value="completo">Completo</SelectItem>
  </SelectContent>
</Select>
```

Confirmar que `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` já estão importados no topo do arquivo (já são usados em outros lugares — ex. o campo "Ambiente" do card Mercado Pago) — não deveria precisar de import novo.

Confirmar também o valor inicial de `f.plano` no estado do dialog (buscar `plano: existente?.plano || 'basico'`) — já usa `'basico'` como default, compatível com os dois valores válidos do `<Select>`, nenhuma mudança necessária ali.

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check app/page.js
```

- [ ] **Step 4: Verificação manual**

Servidor local rodando, login como admin da plataforma (Painel ETNA): abrir o dialog "Configurar assinatura" de uma empresa, confirmar que o campo Plano é um dropdown com exatamente "Básico" e "Completo", salvar, confirmar que a tabela de empresas do painel mostra o novo plano.

- [ ] **Step 5: Commit**

```bash
git add app/page.js
git commit -m "feat(planos): campo plano no Painel ETNA vira seletor Basico/Completo"
```

---

### Task 9: UI — módulo fora do plano aparece bloqueado, não escondido

**Files:**
- Modify: `app/page.js` (tela onde o dono liga/desliga módulos — buscar o componente que renderiza a lista de `MODULOS`/chama `GET /modulos`)

**Interfaces:**
- Consumes: `GET /modulos` (já existente — cada item já devolve `ativo: boolean`; esta task só precisa saber DISTINGUIR "desligado por escolha" de "bloqueado pelo plano", o que a resposta atual não expõe ainda)
- Produces: nada de novo para outras tasks

- [ ] **Step 1: Expor o motivo do bloqueio em `GET /modulos`**

A resposta atual (`route.js`, `GET /modulos`) só devolve `ativo: boolean`. Para a UI diferenciar "desligado, mas o dono pode ligar" de "bloqueado pelo plano, precisa de upgrade", adicionar `disponivelNoPlano`:

```js
    if (route === '/modulos' && method === 'GET') {
      const empresa = await empresaAtual()
      return json({
        disponiveis: Object.entries(MODULOS).map(([chave, m]) => ({
          chave, label: m.label, descricao: m.descricao, ativo: temModulo(empresa, chave),
          disponivelNoPlano: planoInclui(empresa, chave),
        })),
      })
    }
```

- [ ] **Step 2: Escrever o teste que falha**

Adicionar a `tests/backend_test_modulos.py`:

```python
def test_get_modulos_expoe_disponivel_no_plano():
    """UI precisa distinguir 'desligado por escolha' de 'bloqueado pelo plano'
    para mostrar o botao certo (toggle vs. call-to-action de upgrade)."""
    conta = criar_empresa("Modulos Expoe Plano")
    r = requests.get(f"{BASE_URL}/modulos", headers=conta["headers"])
    por_chave = {m["chave"]: m for m in r.json()["disponiveis"]}

    assert por_chave["mesas"]["disponivelNoPlano"] is True
    assert por_chave["estoque"]["disponivelNoPlano"] is False, "Basico nao inclui Estoque"
```

- [ ] **Step 3: Rodar e confirmar que falha, depois que passa**

```bash
BASE_URL=http://localhost:3000/api python -m pytest tests/backend_test_modulos.py::test_get_modulos_expoe_disponivel_no_plano -v
```

Antes do Step 1: FALHA (`KeyError: 'disponivelNoPlano'`). Depois: `1 passed`.

- [ ] **Step 4: Atualizar a UI**

Localizar o componente que renderiza a lista de módulos (buscar onde `GET /modulos` é consumido em `app/page.js` — provavelmente a tela "Empresa" ou um card "Módulos"). Para cada módulo com `disponivelNoPlano === false`, renderizar o toggle desabilitado com uma etiqueta, em vez do `Switch`/toggle normal:

```jsx
{m.disponivelNoPlano ? (
  <Switch checked={m.ativo} onCheckedChange={(v) => toggleModulo(m.chave, v)} />
) : (
  <div className="flex items-center gap-2">
    <Switch checked={false} disabled />
    <Badge variant="outline" className="text-xs">Disponível no plano Completo</Badge>
  </div>
)}
```

Ajustar nomes de variáveis/componentes (`Switch`, `toggleModulo`, etc.) para bater com o que o componente real já usa nesta tela — ler o bloco completo antes de editar, não presumir que os nomes acima existem literalmente.

- [ ] **Step 5: Verificar sintaxe e verificação manual**

```bash
node --check "app/api/[[...path]]/route.js"
node --check app/page.js
```

Servidor local rodando: logar numa empresa no plano Básico, abrir a tela de módulos, confirmar que Estoque/Caixa/Financeiro aparecem com toggle desabilitado e a etiqueta "Disponível no plano Completo"; promover a empresa para Completo (via Painel ETNA ou diretamente no Mongo local) e recarregar, confirmar que os três módulos voltam a ter toggle normal.

- [ ] **Step 6: Commit**

```bash
git add "app/api/[[...path]]/route.js" app/page.js tests/backend_test_modulos.py
git commit -m "feat(planos): tela de modulos distingue desligado de bloqueado pelo plano"
```

---

## Depois de todas as tasks

- [ ] Rodar `node test_modulos_planos.mjs` — 11/11
- [ ] Rodar a suite completa (`python tests/run_all.py`, uma única instância) — todas verdes exceto `rate_limit`
- [ ] Revisão final do branch inteiro (mesmo processo já usado no plano do PDV — modelo mais capaz disponível), focando especialmente em: nenhuma rota de Estoque/Caixa/Financeiro ficou sem o novo gate; a Tanelas FooD realmente não perde acesso no deploy; nenhum teste ficou "consertado" mascarando o bug em vez de corrigi-lo
- [ ] Atualizar `HANDOFF.md` com o resultado final
- [ ] **Fora deste plano, pedido separado do dono para depois:** folder de marketing (Básico vs Completo, vantagens do ETNA, sem preços) e manual didático de configuração inicial para o cliente
