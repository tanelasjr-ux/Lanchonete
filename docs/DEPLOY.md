# Deploy — Restaurant OS

## Opcao A — Docker Compose (VPS / Hostinger)

```bash
cp .env.example .env    # configure segredos e URLs
docker compose up -d --build
```

Servicos expostos:
- `app`        : http://SEU_IP:3000  (painel)
- `postgres`   : 5432 (schema aplicado automaticamente de ./supabase)
- `evolution`  : http://SEU_IP:8080 (WhatsApp)
- `n8n`        : http://SEU_IP:5678 (automacoes)

## Opcao B — EasyPanel

1. Crie um projeto **Restaurant OS**.
2. Adicione um servico **App** do tipo *Dockerfile* apontando para `docker/Dockerfile`.
   - Porta interna: `3000`.
   - Variaveis de ambiente: copie de `.env.example`.
3. Adicione servicos gerenciados (templates do EasyPanel):
   - **PostgreSQL** (ou use Supabase Cloud).
   - **Evolution API** (imagem `atendai/evolution-api`).
   - **n8n** (imagem `n8nio/n8n`).
4. Configure o dominio + SSL (Let's Encrypt) no servico App.
5. Rode as migrations do diretorio `supabase/` no banco escolhido.

## Variaveis criticas em producao

- `JWT_SECRET`: segredo forte e unico.
- `MONGO_URL` **ou** `SUPABASE_*`: defina o backend de dados desejado.
- `NEXT_PUBLIC_BASE_URL`: URL publica final do painel.
- `EVOLUTION_API_URL` / `EVOLUTION_API_KEY`: apos subir a Evolution.
- `N8N_WEBHOOK_URL`: apos criar o workflow no n8n.

## Checklist pos-deploy

- [ ] Migrations aplicadas (schema + RLS + triggers + seed).
- [ ] Cadastro de empresa funcionando (cria tenant + seed demo).
- [ ] Integracoes testadas na tela *Integracoes*.
- [ ] Backup automatico do banco configurado.
