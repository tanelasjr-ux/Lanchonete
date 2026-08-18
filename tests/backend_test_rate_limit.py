"""Rate limiting em /auth/login e /auth/register.

Ate esta sessao nenhum dos dois tinha limite nenhum: login sem limite e
forca bruta de senha; registro sem limite e criacao ilimitada de tenants
(ver docs/ANALISE-COMPETITIVA.md §2.3 e o proprio historico de producao —
71+ empresas de teste ja poluiram producao por falta exatamente disso, C1
no HANDOFF).

Cada teste usa um `X-Forwarded-For` sintetico E UNICO (nunca reaproveitado
entre testes), porque o limite e em memoria no processo do servidor e
persiste entre execucoes da suite inteira. Isso tambem exercita o caminho
real: o resto da suite (que nunca envia esse header) fica de fora do rate
limit de proposito — ver `ipDoCliente()` em lib/rateLimit.js — entao so
aqui o limite de verdade e testado.
"""
import os
import uuid

import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def ip_falso():
    """IP sintetico unico por teste, nunca colidindo com outro caso nem com o resto da suite."""
    return f"203.0.113.{uuid.uuid4().int % 250 + 1}"


def registrar(ip, email=None, empresa_nome=None):
    email = email or f"rl-{os.urandom(4).hex()}@test.com"
    empresa_nome = empresa_nome or f"RL {os.urandom(3).hex()}"
    return requests.post(f"{BASE_URL}/auth/register", headers={"X-Forwarded-For": ip}, json={
        "empresa_nome": empresa_nome, "nome": "Teste", "email": email, "senha": "senha123",
    })


def logar(ip, email, senha="senha123"):
    return requests.post(f"{BASE_URL}/auth/login", headers={"X-Forwarded-For": ip}, json={
        "email": email, "senha": senha,
    })


def test_registro_permite_ate_5_por_hora_e_bloqueia_o_6o():
    ip = ip_falso()
    for i in range(5):
        r = registrar(ip)
        assert r.status_code == 200, f"tentativa {i+1}/5 deveria passar: {r.status_code} {r.text}"

    bloqueado = registrar(ip)
    assert bloqueado.status_code == 429, "6a tentativa na mesma janela deveria ser bloqueada"
    assert "tentativas" in bloqueado.json()["error"].lower()


def test_registro_ips_diferentes_tem_orcamento_independente():
    ip_a = ip_falso()
    ip_b = ip_falso()
    for _ in range(5):
        assert registrar(ip_a).status_code == 200

    assert registrar(ip_a).status_code == 429, "IP A deveria estar no limite"
    assert registrar(ip_b).status_code == 200, "IP B nunca usou seu orcamento, nao pode ser afetado pelo IP A"


def test_login_permite_ate_10_por_15min_e_bloqueia_o_11o():
    ip = ip_falso()
    email = f"rl-login-{os.urandom(4).hex()}@test.com"
    registrar(ip_falso(), email=email)  # cria a conta numa janela separada, nao consome o orcamento de login

    for i in range(10):
        r = logar(ip, email, senha="senha-errada")  # errada de proposito: o que importa e a TENTATIVA, nao o sucesso
        assert r.status_code == 401, f"tentativa {i+1}/10 deveria ser 401 (credenciais invalidas), nao bloqueio"

    bloqueado = logar(ip, email, senha="senha-errada")
    assert bloqueado.status_code == 429, "11a tentativa na mesma janela deveria ser bloqueada"


def test_login_conta_toda_tentativa_nao_so_falhas():
    """Login CORRETO tambem consome o orcamento — senao um atacante alternaria
    senha certa/errada pra nunca ser limitado enquanto tenta emails vizinhos."""
    ip = ip_falso()
    email = f"rl-conta-{os.urandom(4).hex()}@test.com"
    registrar(ip_falso(), email=email)

    for _ in range(10):
        logar(ip, email, senha="senha123")  # senha CORRETA, 10 vezes

    bloqueado = logar(ip, email, senha="senha123")
    assert bloqueado.status_code == 429, "login correto tambem deveria contar pro limite"


def test_login_limite_e_por_ip_e_email_juntos():
    """Mesmo IP, emails diferentes: cada combinacao tem orcamento proprio —
    um IP compartilhado (escritorio) nao pode travar todo mundo por causa
    de uma pessoa errando a senha de UMA conta."""
    ip = ip_falso()
    email_a = f"rl-par-a-{os.urandom(4).hex()}@test.com"
    email_b = f"rl-par-b-{os.urandom(4).hex()}@test.com"
    registrar(ip_falso(), email=email_a)
    registrar(ip_falso(), email=email_b)

    for _ in range(10):
        logar(ip, email_a, senha="errada")
    assert logar(ip, email_a, senha="errada").status_code == 429

    # Mesmo IP, email diferente: orcamento intacto.
    assert logar(ip, email_b, senha="errada").status_code == 401


# NAO HA teste automatizado para "sem X-Forwarded-For, o limite e pulado"
# (ipDoCliente() devolve null -> route.js nao chama checarLimite()).
# Verificado nesta sessao que NAO da pra confiar em black-box HTTP local pra
# isso: o Avast (antivirus, processo `aswMonFltProxy`) injeta
# `X-Forwarded-For: 127.0.0.1` em TODO trafego HTTP local desta maquina,
# mesmo sem proxy real na frente e mesmo sem o cliente mandar o header —
# confirmado com log temporario em ipDoCliente() durante o desenvolvimento.
# Numa maquina sem esse software, ou em CI, o teste correspondente
# passaria; aqui ele so mediria comportamento do antivirus, nao do app. O
# branch e uma linha (`if (forwarded) ... else return null`) — a garantia
# vem da leitura do codigo em lib/rateLimit.js, nao de um teste que
# dependeria de uma condicao de rede fora do controle da aplicacao.
#
# `RATE_LIMIT_DISABLED=1` (nunca setado em producao) existe por causa desse
# mesmo achado: sem ele, rodar a suite completa nesta maquina bloquearia
# sozinha depois de 5 registros, porque TODOS os arquivos de teste (que nao
# sabem deste header novo) cairiam no balde de "127.0.0.1" injetado pelo AV.


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
