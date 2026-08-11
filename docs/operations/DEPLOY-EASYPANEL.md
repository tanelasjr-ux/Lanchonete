# Deploy no EasyPanel (Hostinger)

Guia para subir o Restaurant OS como serviço no projeto `restaurante` do
EasyPanel. Escrito depois de **validar a imagem de produção localmente** — o
que está aqui foi executado, não presumido.

> **Este é um ambiente de STAGING**, não produção: sem domínio próprio, sem
> usuário real, apontando para um banco Supabase que hoje contém apenas dados
> de teste. Ver §6 antes de tratar como produção.

---

## 1. Por que subir agora (e não depois)

A **Evolution API já roda nesse mesmo projeto** do EasyPanel. Rodando o app ao
lado dela, o fluxo de WhatsApp passa a ser testável de ponta a ponta pela
primeira vez — localmente isso nunca foi possível. Esse é o principal ganho
técnico deste deploy, acima de "ver a tela no ar".

---

## 2. O que a imagem contém (e o que não contém)

`docker/Dockerfile` — multi-stage, saída `standalone` do Next.js.
**Tamanho final: 291 MB.**

**Nenhum segredo entra na imagem.** O `.dockerignore` exclui explicitamente:

- `.env` — service role key, senha do banco, `JWT_SECRET`
- `backups/` — dumps do Postgres, podem conter dado real de cliente
- `scripts/`, `docs/`, testes, `.git`, `supabase/`

Toda configuração chega em **runtime**, por variável de ambiente.

---

## 3. Variáveis de ambiente

Configurar na aba **Environment** do serviço. Nunca commitar estes valores.

### Obrigatórias

| Variável | Valor | Observação |
|---|---|---|
| `JWT_SECRET` | *(gerar, ver abaixo)* | **Sem ela o app sobe em modo degradado e recusa autenticar.** Não reaproveitar a de desenvolvimento |
| `DATABASE_PROVIDER` | `supabase` | `mongo` é o default do código; aqui queremos Supabase |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | *(secreta)* | Settings → API. **Nunca expor no frontend** |

Gerar um segredo forte:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Recomendadas

| Variável | Valor | Observação |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | mesma URL | Usada pelo frontend |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key | Pública por natureza |
| `CORS_ORIGINS` | URL do serviço | Hoje o default é `*`. Restringir quando houver domínio |

**Não** definir `MONGO_URL`/`DB_NAME`: com `DATABASE_PROVIDER=supabase` elas
não são usadas, e deixá-las de fora evita ligar no banco errado por engano.

---

## 4. Configuração do serviço no EasyPanel

1. No projeto `restaurante`, criar serviço do tipo **App**.
2. Origem: repositório GitHub `tanelasjr-ux/Lanchonete`, branch `main`.
3. Build: **Dockerfile**, caminho `docker/Dockerfile`.
4. Porta: **3000**.
5. Preencher as variáveis do §3.
6. Deploy.

**Não usar o `docker-compose.yml` da raiz.** Ele sobe postgres, evolution-api e
n8n junto — no seu EasyPanel a Evolution e o n8n já existem, e o banco é o
Supabase hospedado. Usá-lo criaria serviços duplicados. Aquele arquivo serve
para subir a stack inteira do zero em um VPS limpo, que não é este caso.

---

## 5. Verificação pós-deploy

```
GET /api/health
```

Resposta esperada:

```json
{ "service": "restaurant-os", "status": "ok", "database": "supabase", ... }
```

**Se vier `"status": "degraded"` com HTTP 503**, o campo `config_faltando` diz
exatamente qual variável falta. Esse endpoint existe justamente para isso: sem
ele, um deploy sem `JWT_SECRET` parecia saudável e só quebrava no primeiro
login bem-sucedido — falha tardia e difícil de diagnosticar.

O `HEALTHCHECK` do Dockerfile usa essa mesma rota, então o container é marcado
como não-saudável automaticamente em caso de má configuração.

### Validação executada localmente contra esta imagem

Suíte completa rodada contra o **container de produção** (não contra o dev
server), apontando para o Supabase real:

| Suíte | Resultado |
|---|---|
| `backend_test.py` | **40/40** |
| `backend_test_v2.py` | **39/39** |
| `backend_test_v3.py` | **32/33** |

A única falha do v3 é o não-bug já documentado (`tipo:'conversation'` da
Evolution API). Cobre autenticação, isolamento multi-tenant, regra financeira,
mesas/comandas e os caminhos de integração não configurada.

---

## 6. Pontos de atenção antes de tratar como produção

1. **O banco tem dados de teste acumulados.** O projeto Supabase contém hoje
   ~91 empresas, todas geradas por migração de desenvolvimento e por rodadas
   da suíte de regressão (cada execução registra tenants). Nenhum dado real de
   cliente — mas convém zerar antes de uso sério. Um `delete from empresas`
   limpa tudo em cascata (`ON DELETE CASCADE`).
2. **O frontend nunca foi validado em navegador** (`test_result.md`). A suíte
   cobre API; a interface não.
3. **Auth ainda é JWT local.** A migração para Supabase Auth está auditada mas
   não implementada — ver `docs/plans/PHASE-8-AUTH-AUDIT.md`.
4. **RLS não está sendo exercido**: o app usa `service_role`, que ignora RLS.
   O isolamento hoje é 100% da camada de aplicação.
5. **Sem domínio, sem HTTPS próprio.** Aceitável para staging; não para tráfego
   real com dado de cliente.

---

## 7. Rollback

O deploy não é destrutivo e não altera schema. Para voltar atrás:

- **Reverter versão**: redeploy do commit anterior pelo próprio EasyPanel.
- **Trocar de banco sem redeploy**: mudar `DATABASE_PROVIDER` para `mongo`
  (exige `MONGO_URL`/`DB_NAME` acessíveis a partir do servidor) e reiniciar.
- **Derrubar**: parar o serviço. Nada no Supabase depende do app estar no ar.
