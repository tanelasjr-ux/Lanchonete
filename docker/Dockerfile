# ============================================================================
# Restaurant OS :: Dockerfile (Next.js standalone, multi-stage)
# ----------------------------------------------------------------------------
# Pareado com `.dockerignore` — sem ele, `COPY . .` levaria `.env` (service_role
# key, senha do banco, JWT_SECRET) e `backups/` (dump com dado real de cliente)
# para dentro da imagem. Nenhum segredo entra no build: tudo chega em runtime
# por variavel de ambiente.
#
# `next.config.js` usa `output: 'standalone'`, entao o runner copia apenas o
# bundle standalone (que ja embute so as dependencias realmente usadas) em vez
# do `node_modules` inteiro — imagem menor e boot mais rapido.
# ============================================================================

FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NODE_ENV=production ja no build para o Next otimizar o bundle.
#
# Cuidado ao mexer em codigo de modulo das rotas: `next build` AVALIA o modulo
# para coletar dados das rotas, com NODE_ENV=production e sem as variaveis de
# runtime. Qualquer validacao de env feita no nivel do modulo (e nao no uso)
# quebra o build aqui — foi exatamente o que aconteceu com a exigencia de
# JWT_SECRET, resolvida tornando a checagem lazy.
ENV NODE_ENV=production
RUN yarn build

# Arvore de dependencias so do runner de migrations.
#
# Fica separada de proposito: `scripts/migrate.mjs` roda no entrypoint, ANTES e
# FORA do Next, entao o `pg` nunca seria tracado para dentro do bundle
# standalone (que so inclui o que o build enxergou). Copiar o node_modules
# inteiro do stage `deps` resolveria, mas arrastaria centenas de MB para uma
# imagem que so precisa de um driver Postgres.
FROM node:20-alpine AS migrator-deps
WORKDIR /migrator
RUN npm install --no-package-lock --no-audit --no-fund --omit=dev pg@8

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Saida standalone: server.js + apenas as dependencias necessarias.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# O standalone do Next.js NAO inclui `public/` sozinho — precisa deste COPY
# explicito, sempre (doc oficial do `output: 'standalone'`). Faltou aqui
# desde que a pasta passou a existir (logo ETNA, icones do PWA): esses
# arquivos vinham dando 404 em producao ha dias, so nao apareceu porque
# ninguem tinha reparado num <img> quebrado ate agora (2026-08-19).
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Runner de migrations: driver, script, SQLs e a CA do Supabase.
# Os SQLs sao lidos em runtime (o script varre o diretorio), entao precisam
# existir na imagem — nao basta terem sido usados no build.
#
# O `pg` entra DENTRO de /app/node_modules, e nao numa arvore paralela com
# NODE_PATH, porque `migrate.mjs` e ESM — e NODE_PATH so vale para o `require()`
# do CommonJS, sendo ignorado por `import`. A resolucao ESM sobe de
# /app/scripts/ ate /app/node_modules e acha o driver ali. O COPY mescla (nao
# substitui) o diretorio: o standalone nao traz `pg`, entao nao ha colisao.
COPY --from=migrator-deps --chown=nextjs:nodejs /migrator/node_modules ./node_modules
COPY --chown=nextjs:nodejs scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=nextjs:nodejs supabase/migrations ./supabase/migrations
COPY --chown=nextjs:nodejs supabase/prod-ca-2021.crt ./supabase/prod-ca-2021.crt
COPY --chown=nextjs:nodejs docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Healthcheck usa a rota real da API, que exercita o boot da aplicacao
# (inclusive a factory de persistencia) — nao so o processo estar vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Entrypoint migra o schema e so entao entrega o processo ao servidor.
CMD ["./entrypoint.sh"]
