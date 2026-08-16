#!/usr/bin/env python
"""
Runner unico das suites de API do Restaurant OS.

    npm test
    BASE_URL=http://localhost:3000/api python tests/run_all.py

Descobre todo `tests/backend_test_*.py`, roda cada um como subprocesso e
imprime um resumo consolidado.

Por que subprocesso e nao import: as suites mais antigas (backend_test.py,
_v2, _v3) sao SCRIPTS — executam no import, sem funcao de entrada e sem guarda
`__main__`. Importa-las rodaria os testes no momento errado e sem isolamento.

Duas protecoes contra falso verde, que e o problema que este runner existe para
resolver:

1. **Servidor fora do ar aborta tudo.** Sem isso, sete suites falhariam por
   conexao recusada e o resumo diria "0 passaram" como se fosse um resultado.
2. **Exit code E saida sao considerados.** Ate 2026-08-14 quatro das sete
   suites imprimiam falhas e saiam com 0. Isso foi corrigido, mas o runner
   continua olhando a saida em busca de marcadores de falha — se alguem
   adicionar uma suite sem codigo de saida, o runner acusa em vez de mentir.
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")
TESTS_DIR = Path(__file__).parent

# O console do Windows costuma vir num codepage legado, e as suites imprimem
# emoji. Sem isto, `print` levanta UnicodeEncodeError e derruba o runner por
# causa de um simbolo — falha por motivo errado, que e o oposto do objetivo.
for _fluxo in (sys.stdout, sys.stderr):
    try:
        _fluxo.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Marcadores de falha usados pelas suites. Se algum aparecer na saida, a suite
# e considerada falha mesmo que tenha saido com codigo 0.
#
# Cada marcador exige um numero diferente de zero depois de si — sem isso,
# "❌ FAILED: 0" ou "🔴 CRITICAL FAILURES: 0" (as proprias linhas de resumo que
# uma suite 100% verde imprime) davam falso-positivo. Foi pego na primeira
# execucao real desta suite (A1, 2026-08-14): backend_test.py passou 40/40 e
# o runner acusou falha por causa da propria linha que dizia "0 falhas".
MARCADORES_FALHA = [
    re.compile(r"(FAILED|FALHOU|FALHAS?)\s*:?\s*([1-9]\d*)", re.IGNORECASE),
    re.compile(r"^\s*(❌|🔴).*?([1-9]\d*)", re.MULTILINE),
    re.compile(r"^FAIL:", re.MULTILINE),
]


def servidor_no_ar():
    """Confirma que a API responde antes de rodar qualquer suite."""
    try:
        import requests
    except ImportError:
        print("ERRO: o pacote `requests` nao esta instalado.")
        print("      Instale com: pip install requests")
        return False

    alvo = BASE_URL.rstrip("/").removesuffix("/api") + "/api/health"
    try:
        r = requests.get(alvo, timeout=5)
        if r.status_code >= 500:
            print(f"ERRO: {alvo} respondeu {r.status_code}.")
            return False
        try:
            saude = r.json()
            banco = saude.get("database", "?")
            status = saude.get("status", "?")
            print(f"Servidor no ar — banco: {banco} · status: {status}")
            if saude.get("config_faltando"):
                print(f"  aviso: configuracao faltando: {saude['config_faltando']}")
        except ValueError:
            print("Servidor no ar.")
        return True
    except Exception as e:
        print(f"ERRO: nao foi possivel falar com {alvo}")
        print(f"      {type(e).__name__}: {e}")
        print()
        print("      Suba o ambiente local antes de rodar os testes:")
        print("        1. Docker Desktop -> docker start ros-mongo-local")
        print("        2. npm run dev:no-reload")
        return False


def rodar_suite(caminho):
    """Roda uma suite e devolve (nome, ok, duracao, saida)."""
    inicio = time.monotonic()
    proc = subprocess.run(
        [sys.executable, str(caminho)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "BASE_URL": BASE_URL, "PYTHONIOENCODING": "utf-8"},
        cwd=str(TESTS_DIR.parent),
    )
    duracao = time.monotonic() - inicio
    saida = (proc.stdout or "") + (proc.stderr or "")

    ok = proc.returncode == 0
    if ok and any(m.search(saida) for m in MARCADORES_FALHA):
        # Saiu com 0 mas imprimiu falha: a suite provavelmente nao propaga
        # codigo de saida. Trata como falha e avisa.
        ok = False
        saida += (
            "\n[run_all] Suite saiu com codigo 0 mas imprimiu marcador de falha."
            "\n[run_all] Verifique se ela termina com sys.exit(1) quando ha falha.\n"
        )
    return caminho.name, ok, duracao, saida


def main():
    print("=" * 72)
    print(f"Restaurant OS — suites de API   ({BASE_URL})")
    print("=" * 72)

    if not servidor_no_ar():
        print()
        print("Abortado: nenhuma suite foi executada.")
        return 2

    suites = sorted(TESTS_DIR.glob("backend_test*.py"))
    if not suites:
        print("ERRO: nenhuma suite encontrada em tests/")
        return 2

    print(f"{len(suites)} suites encontradas\n")

    resultados = []
    for caminho in suites:
        print(f"→ {caminho.name} ...", end="", flush=True)
        nome, ok, duracao, saida = rodar_suite(caminho)
        resultados.append((nome, ok, duracao, saida))
        print(f" {'PASSOU' if ok else 'FALHOU'}  ({duracao:.1f}s)")

    print()
    print("=" * 72)
    print("RESUMO")
    print("=" * 72)
    for nome, ok, duracao, _ in resultados:
        print(f"  {'✓' if ok else '✗'}  {nome:<34} {duracao:>6.1f}s")

    falhas = [r for r in resultados if not r[1]]
    print()
    print(f"{len(resultados) - len(falhas)}/{len(resultados)} suites passaram")

    if falhas:
        print()
        print("=" * 72)
        print("SAIDA DAS SUITES QUE FALHARAM")
        print("=" * 72)
        for nome, _, _, saida in falhas:
            print(f"\n----- {nome} " + "-" * (66 - len(nome)))
            # Ultimas 40 linhas: o resumo de cada suite fica no fim.
            linhas = saida.strip().splitlines()
            print("\n".join(linhas[-40:]) if linhas else "(sem saida)")

    return 1 if falhas else 0


if __name__ == "__main__":
    raise SystemExit(main())
