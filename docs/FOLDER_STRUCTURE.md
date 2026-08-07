# Estrutura de Pastas — Restaurant OS

```
/app
├── app/                          # Next.js App Router
│   ├── api/[[...path]]/route.js  # API (Controller + Service + Repository)
│   ├── page.js                   # Painel (UI SPA)
│   ├── layout.js                 # Root layout + Providers
│   ├── providers.js              # ThemeProvider + React Query
│   └── globals.css               # Design System (tokens claro/escuro)
├── components/ui/                # shadcn/ui
├── lib/
│   └── integrations/             # Ports & Adapters (desacoplados)
│       ├── supabase.js           # Provider Supabase (ativado por env)
│       ├── evolution.js          # WhatsApp / Evolution API
│       └── n8n.js                # Automacoes / webhooks
├── packages/
│   └── domain/                   # Camada de dominio (DDD) compartilhada
│       └── src/index.ts          # Entidades + contratos de repositorio
├── supabase/                     # Banco (PostgreSQL)
│   ├── migrations/0001_init.sql  # Schema, constraints, indices
│   ├── policies_rls.sql          # Row Level Security
│   ├── triggers.sql              # Triggers e functions
│   └── seed.sql                  # Seeds RBAC
├── docker/
│   └── Dockerfile
├── docker-compose.yml            # app + postgres + evolution + n8n
├── docs/                         # Documentacao
│   ├── ARCHITECTURE.md
│   ├── FOLDER_STRUCTURE.md
│   └── DEPLOY.md
├── .env / .env.example
└── README.md
```

## Convencao de camadas (backend)

- **Controller**: parsing da rota/metodo -> chama service. (em `route.js`)
- **Service**: regra de negocio + auditoria + eventos.
- **Repository**: acesso a dados sempre com `empresa_id`.
- **Infra/Adapters**: MongoDB, Supabase, Evolution, n8n.
