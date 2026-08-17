#!/bin/sh
# ============================================================================
# Restaurant OS :: entrypoint do container
# ----------------------------------------------------------------------------
# Ordem deliberada: MIGRAR o schema, depois SUBIR o servidor.
#
# Antes disto o EasyPanel fazia auto-deploy do codigo no push, mas migrations
# eram um passo manual via psql que dependia de alguem lembrar. Em 2026-08-18
# descobrimos que ninguem lembrou: 0019 (estoque), 0020 (CMV) e 0021 (imagem do
# cardapio) estavam commitadas ha dias com o banco de producao sem as colunas —
# duas features "concluidas" quebradas em producao, em silencio.
#
# `exec` no final substitui o shell pelo processo do Node, em vez de deixar o
# shell como PAI dele. Isso importa: sem `exec`, o Node vira PID 2 e nao recebe
# o SIGTERM que o Docker manda no PID 1 no shutdown — o container so morreria
# no timeout do SIGKILL, cortando requisicoes em andamento.
# ============================================================================
set -e

echo "[entrypoint] verificando schema do banco..."
# Sem NODE_PATH de proposito: `migrate.mjs` e ESM, e NODE_PATH so afeta o
# `require()` do CommonJS — `import` o ignora. O Dockerfile instala o driver
# `pg` dentro de /app/node_modules justamente para a resolucao ESM padrao
# encontra-lo subindo a partir de /app/scripts/.
node /app/scripts/migrate.mjs

echo "[entrypoint] iniciando servidor..."
exec node server.js
