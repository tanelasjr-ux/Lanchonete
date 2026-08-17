"""Feature flags que realmente controlam acesso (B1 do programa de profissionalizacao).

Ate 2026-08-18 as flags eram decorativas: existiam no banco, apareciam na tela,
e nenhum dos 81 endpoints as consultava. Desligar "Estoque" nao desligava o
Estoque. Estes testes existem para que isso nao volte em silencio — se alguem
criar uma rota de caixa nova sem o portao, o teste de isolamento acusa.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def criar_empresa(nome):
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


def desligar(headers, modulo):
    r = requests.put(f"{BASE_URL}/modulos/{modulo}", headers=headers, json={"ativo": False})
    assert r.status_code == 200, f"nao consegui desligar {modulo}: {r.status_code} {r.text}"
    return r.json()


def ligar(headers, modulo):
    r = requests.put(f"{BASE_URL}/modulos/{modulo}", headers=headers, json={"ativo": True})
    assert r.status_code == 200, r.text
    return r.json()


def test_signup_liga_os_modulos_que_o_produto_entrega():
    """Empresa nova nasce com Estoque e Caixa LIGADOS.

    Regressao direta do bug de origem: o signup gravava `estoque: false` e
    `caixa: false` em empresas que usavam os dois modulos normalmente. Enquanto
    ninguem lia as flags isso era inofensivo; com o portao real valendo, um
    default errado tranca o cliente para fora no primeiro login.
    """
    headers = criar_empresa("Signup Flags")
    r = requests.get(f"{BASE_URL}/modulos", headers=headers)
    assert r.status_code == 200
    ativos = {m["chave"]: m["ativo"] for m in r.json()["disponiveis"]}

    assert ativos["estoque"] is True, "Estoque funciona no produto; nao pode nascer desligado"
    assert ativos["caixa"] is True, "Caixa funciona no produto; nao pode nascer desligado"
    assert ativos["mesas"] is True


def test_auth_me_expoe_modulos_resolvidos():
    """/auth/me devolve `modulos` pronto — o front nao reinterpreta as flags."""
    headers = criar_empresa("Auth Me Modulos")
    r = requests.get(f"{BASE_URL}/auth/me", headers=headers)
    assert r.status_code == 200
    modulos = r.json().get("modulos")
    assert modulos is not None, "/auth/me precisa devolver `modulos`"
    assert modulos["caixa"] is True

    desligar(headers, "caixa")
    depois = requests.get(f"{BASE_URL}/auth/me", headers=headers).json()["modulos"]
    assert depois["caixa"] is False, "/auth/me tem que refletir o desligamento"


def test_caixa_desligado_bloqueia_todas_as_rotas_de_caixa():
    """Modulo desligado => 403 em TODAS as rotas de caixa, nao so na primeira.

    O portao e por familia de rota (`seg[0] === 'caixa'`) justamente para que
    uma rota nova nasca protegida em vez de depender de alguem lembrar.
    """
    headers = criar_empresa("Caixa Off")
    # Com o modulo ligado, abrir caixa funciona.
    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 100})
    assert r.status_code in (200, 201), f"deveria abrir com modulo ligado: {r.text}"

    desligar(headers, "caixa")

    for metodo, rota, corpo in [
        ("GET", "/caixa/atual", None),
        ("GET", "/caixa/historico", None),
        ("POST", "/caixa/abrir", {"valor_abertura": 50}),
        ("POST", "/caixa/movimento", {"tipo": "sangria", "valor": 10, "motivo": "x"}),
        ("POST", "/caixa/fechar", {"valor_contado": 100}),
    ]:
        r = requests.request(metodo, f"{BASE_URL}{rota}", headers=headers, json=corpo)
        assert r.status_code == 403, f"{metodo} {rota} deveria dar 403, deu {r.status_code}"
        assert "desativado" in r.json().get("error", "").lower(), \
            f"{rota}: mensagem precisa dizer que o modulo esta desativado, veio {r.json()}"


def test_mesas_desligado_bloqueia_mesas_e_comandas():
    """"Mesas & Comandas" e um modulo so: desligar barra as duas superficies.

    Deixar /comandas passando com /mesas bloqueada recriaria a incoerencia que
    este trabalho veio eliminar (uma comanda so existe sobre uma mesa).
    """
    headers = criar_empresa("Mesas Off")
    assert requests.get(f"{BASE_URL}/mesas", headers=headers).status_code == 200

    desligar(headers, "mesas")

    assert requests.get(f"{BASE_URL}/mesas", headers=headers).status_code == 403
    assert requests.get(f"{BASE_URL}/comandas", headers=headers).status_code == 403


def test_estoque_desligado_devolve_lista_vazia_nao_403():
    """Estoque desligado zera o alerta, mas NAO devolve erro.

    Este endpoint alimenta um polling de 30s que roda em toda tela; 403 viraria
    um toast vermelho a cada meio minuto por um modulo nao contratado. A
    resposta honesta e "nada para alertar".
    """
    headers = criar_empresa("Estoque Off")
    # Produto que dispararia o alerta se o modulo estivesse ligado.
    p = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Item Critico", "preco": 10,
        "estoque_habilitado": True, "estoque_quantidade": 0, "estoque_minimo": 5,
    })
    assert p.status_code == 201, p.text

    ligado = requests.get(f"{BASE_URL}/produtos/estoque-baixo", headers=headers)
    assert ligado.status_code == 200
    assert len(ligado.json()["produtos"]) >= 1, "com o modulo ligado o item deveria alertar"

    desligar(headers, "estoque")

    off = requests.get(f"{BASE_URL}/produtos/estoque-baixo", headers=headers)
    assert off.status_code == 200, "nao pode ser 403: e polling de fundo"
    assert off.json()["produtos"] == [], "modulo desligado nao alerta nada"


def test_religar_devolve_o_acesso_e_os_dados():
    """Desligar nao apaga nada: religar traz o modulo e os dados de volta."""
    headers = criar_empresa("Religar")
    requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 250})

    desligar(headers, "caixa")
    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers).status_code == 403

    ligar(headers, "caixa")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    assert r.status_code == 200
    assert r.json()["caixa"] is not None, "o caixa aberto antes do desligamento tem que continuar la"
    assert r.json()["caixa"]["valor_abertura"] == 250


def test_modulo_sem_implementacao_nao_e_configuravel():
    """PUT num modulo "Em breve" da 404 — nao existe o que ligar.

    Aceitar o PUT gravaria uma flag `crm: true` que nao habilita CRM nenhum:
    exatamente a classe de mentira que este trabalho removeu.
    """
    headers = criar_empresa("Em Breve")
    r = requests.put(f"{BASE_URL}/modulos/crm", headers=headers, json={"ativo": True})
    assert r.status_code == 404

    catalogo = requests.get(f"{BASE_URL}/modulos", headers=headers).json()
    configuraveis = {m["chave"] for m in catalogo["disponiveis"]}
    em_breve = {m["chave"] for m in catalogo["em_breve"]}
    assert "crm" in em_breve
    assert "crm" not in configuraveis
    assert configuraveis == {"mesas", "estoque", "caixa"}


def test_modulo_de_uma_empresa_nao_afeta_outra():
    """Desligar caixa na empresa A nao pode desligar na empresa B."""
    headers_a = criar_empresa("Modulo Multi A")
    headers_b = criar_empresa("Modulo Multi B")

    desligar(headers_a, "caixa")

    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers_a).status_code == 403
    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers_b).status_code == 200


def test_papel_sem_permissao_nao_configura_modulo():
    """Portao de plano e portao de papel sao independentes e ambos valem.

    Um ATENDENTE nao decide o que a empresa contratou — mesmo que a empresa
    tenha o modulo, mexer no interruptor e de OWNER/ADMIN.
    """
    headers_owner = criar_empresa("Papel Modulo")
    r = requests.post(f"{BASE_URL}/usuarios", headers=headers_owner, json={
        "nome": "Atendente", "email": f"at-{os.urandom(4).hex()}@test.com",
        "senha": "senha123", "papel": "ATENDENTE",
    })
    assert r.status_code == 201, r.text
    login = requests.post(f"{BASE_URL}/auth/login", json={
        "email": r.json()["email"], "senha": "senha123",
    })
    assert login.status_code == 200, login.text
    headers_at = {"Authorization": f"Bearer {login.json()['token']}"}

    bloqueado = requests.put(f"{BASE_URL}/modulos/caixa", headers=headers_at, json={"ativo": False})
    assert bloqueado.status_code == 403, "ATENDENTE nao configura modulo"

    # E o modulo continua ligado — a tentativa nao pode ter efeito colateral.
    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers_owner).status_code == 200


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
