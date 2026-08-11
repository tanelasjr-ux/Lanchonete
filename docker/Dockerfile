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

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Saida standalone: server.js + apenas as dependencias necessarias.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Sem `COPY /app/public`: o projeto nao tem pasta public/ (todo o visual vem
# do bundle e do Tailwind). Se um dia ela existir, reintroduzir esta linha —
# `COPY` de caminho inexistente falha o build.

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Healthcheck usa a rota real da API, que exercita o boot da aplicacao
# (inclusive a factory de persistencia) — nao so o processo estar vivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
