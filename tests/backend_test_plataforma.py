"""Painel da Plataforma: controle total do dono da ETNA sobre as empresas
clientes (assinaturas, bloqueio, ultimo acesso) + aviso humanizado de atraso
mostrado ao proprio cliente.

Identidade de admin e por E-MAIL, numa tabela separada (`plataforma_admins`),
nunca uma flag em `usuarios` — ver comentario em
lib/repositories/*/plataformaAdminRepository.js. Como nao existe (nem deve
existir) um endpoint de auto-promocao a admin, estes testes promovem o
usuario de teste inserindo direto no Mongo local (mesmo espirito de
RATE_LIMIT_DISABLED: ferramenta so de dev local, nunca aponta para producao).
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "restaurant_os_dev")

_mongo = MongoClient(MONGO_URL)
_db = _mongo[DB_NAME]


def criar_empresa(nome):
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    body = r.json()
    return {
        "headers": {"Authorization": f"Bearer {body['token']}"},
        "email": email,
        "empresa_id": body["empresa"]["id"],
    }


def promover_admin(email):
    """So existe via manipulacao direta do banco local — de proposito."""
    _db.plataforma_admins.insert_one({"email": email, "nome": "Admin Teste", "ativo": True})


def login(email, senha="senha123"):
    r = requests.post(f"{BASE_URL}/auth/login", json={"email": email, "senha": senha})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(autouse=True)
def limpar_admins():
    yield
    _db.plataforma_admins.delete_many({"nome": "Admin Teste"})


def test_usuario_comum_nao_e_admin_da_plataforma():
    conta = criar_empresa("Nao Admin")
    r = requests.get(f"{BASE_URL}/plataforma/eu", headers=conta["headers"])
    assert r.status_code == 200
    assert r.json()["admin"] is False


def test_email_promovido_vira_admin_da_plataforma():
    conta = criar_empresa("Vira Admin")
    promover_admin(conta["email"])
    r = requests.get(f"{BASE_URL}/plataforma/eu", headers=conta["headers"])
    assert r.status_code == 200
    assert r.json()["admin"] is True


def test_usuario_comum_leva_403_em_toda_rota_de_plataforma():
    """Sem estar em `plataforma_admins`, nenhuma rota do painel responde -
    nem para o dono de uma empresa normal, OWNER incluso."""
    conta = criar_empresa("Sem Acesso Plataforma")
    alvo = criar_empresa("Empresa Alvo 1")
    h = conta["headers"]

    chamadas = [
        ("GET", "/plataforma/empresas", None),
        ("PUT", f"/plataforma/empresas/{alvo['empresa_id']}/assinatura",
         {"valor": 199, "dia_vencimento": 10, "proximo_vencimento": "2026-09-10"}),
        ("PUT", "/plataforma/assinaturas/qualquer-id/pagar", {}),
        ("PUT", "/plataforma/assinaturas/qualquer-id/cancelar", {}),
        ("PUT", f"/plataforma/empresas/{alvo['empresa_id']}/bloqueio", {"ativo": False}),
        ("PUT", f"/plataforma/empresas/{alvo['empresa_id']}/modulos/caixa", {"ativo": False}),
    ]
    for metodo, rota, corpo in chamadas:
        r = requests.request(metodo, f"{BASE_URL}{rota}", headers=h, json=corpo)
        assert r.status_code == 403, f"{metodo} {rota} deveria dar 403 para nao-admin, deu {r.status_code}: {r.text}"


def test_assinatura_sem_cadastro_nao_gera_aviso():
    conta = criar_empresa("Sem Assinatura Cadastrada")
    r = requests.get(f"{BASE_URL}/assinatura/status", headers=conta["headers"])
    assert r.status_code == 200
    assert r.json()["aviso"] is None


def test_admin_configura_assinatura_e_ela_aparece_na_listagem():
    admin = criar_empresa("Admin Configura")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Configurado")

    r = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"plano": "pro", "valor": 249.9, "dia_vencimento": 15, "proximo_vencimento": "2026-09-15"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status_efetivo"] == "ativa"

    listagem = requests.get(f"{BASE_URL}/plataforma/empresas", headers=admin["headers"])
    assert listagem.status_code == 200
    linha = next(e for e in listagem.json()["empresas"] if e["empresa_id"] == cliente["empresa_id"])
    assert linha["assinatura"]["plano"] == "pro"
    assert linha["assinatura"]["valor"] == 249.9


def test_pagamento_avanca_vencimento_e_registra_historico():
    admin = criar_empresa("Admin Pagamento")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Paga")

    criada = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"valor": 100, "dia_vencimento": 5, "proximo_vencimento": "2026-08-05"},
    ).json()
    assert criada["status_efetivo"] == "atrasada", "vencimento no passado tem que aparecer atrasada"

    pago = requests.put(
        f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pagar",
        headers=admin["headers"],
        json={"valor": 100, "metodo": "pix"},
    )
    assert pago.status_code == 200, pago.text
    body = pago.json()
    assert body["assinatura"]["proximo_vencimento"] == "2026-09-05", "deveria avancar exatamente 1 mes"
    assert body["assinatura"]["status_efetivo"] == "ativa", "pagou, entao nao esta mais atrasada"
    assert body["pagamento"]["valor"] == 100


def test_bloqueio_total_impede_login_e_desbloqueio_devolve():
    admin = criar_empresa("Admin Bloqueia")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Bloqueado")

    bloq = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/bloqueio",
        headers=admin["headers"], json={"ativo": False},
    )
    assert bloq.status_code == 200, bloq.text

    negado = requests.post(f"{BASE_URL}/auth/login", json={"email": cliente["email"], "senha": "senha123"})
    assert negado.status_code == 403, "empresa bloqueada nao pode logar"

    desbloq = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/bloqueio",
        headers=admin["headers"], json={"ativo": True},
    )
    assert desbloq.status_code == 200

    ok = requests.post(f"{BASE_URL}/auth/login", json={"email": cliente["email"], "senha": "senha123"})
    assert ok.status_code == 200, "desbloqueado, o login normal tem que voltar"


def test_sessao_ja_aberta_e_cortada_ao_bloquear_no_meio_do_uso():
    """Nao basta impedir login novo: um token de 7 dias emitido ANTES do
    bloqueio tem que parar de funcionar imediatamente, nao so quando expirar."""
    admin = criar_empresa("Admin Corta Sessao")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Sessao Ativa")

    ainda_ok = requests.get(f"{BASE_URL}/empresa", headers=cliente["headers"])
    assert ainda_ok.status_code == 200

    requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/bloqueio",
        headers=admin["headers"], json={"ativo": False},
    )

    cortado = requests.get(f"{BASE_URL}/empresa", headers=cliente["headers"])
    assert cortado.status_code == 403, "token antigo de empresa bloqueada tem que parar na hora"


def test_modulo_via_plataforma_bloqueia_igual_ao_toggle_do_proprio_dono():
    admin = criar_empresa("Admin Modulo")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Modulo Via Plataforma")

    ligado = requests.get(f"{BASE_URL}/caixa/atual", headers=cliente["headers"])
    assert ligado.status_code == 200

    r = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/modulos/caixa",
        headers=admin["headers"], json={"ativo": False},
    )
    assert r.status_code == 200, r.text

    desligado = requests.get(f"{BASE_URL}/caixa/atual", headers=cliente["headers"])
    assert desligado.status_code == 403


def test_aviso_ao_cliente_segue_a_escada_sem_antecedencia():
    """Regressao direta da decisao do dono (2026-08-18): nunca avisar antes
    do vencimento; amber nos 3 primeiros dias corridos de atraso, vermelho
    depois disso."""
    admin = criar_empresa("Admin Aviso Escada")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Aviso Escada")

    requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"valor": 150, "dia_vencimento": 10, "proximo_vencimento": "2026-08-16"},
    )
    status = requests.get(f"{BASE_URL}/assinatura/status", headers=cliente["headers"])
    assert status.status_code == 200
    aviso = status.json()["aviso"]
    assert aviso is not None, "vencimento ja passou (2026-08-16 < hoje), tem que haver aviso"
    assert aviso["nivel"] in ("amber", "vermelho")
    assert aviso["dias"] >= 1


def test_pausar_aviso_esconde_do_cliente_mas_mantem_atrasada_pro_dono():
    """Pedido do dono (2026-08-19): dar cortesia sem perder o controle real
    sobre quem esta devendo. `aviso_pausado_ate` esconde o banner do
    cliente, mas o Painel da Plataforma continua marcando "atrasada"."""
    admin = criar_empresa("Admin Pausa Aviso")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Pausa Aviso")

    criada = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"valor": 150, "dia_vencimento": 10, "proximo_vencimento": "2026-08-01"},
    ).json()
    assert criada["status_efetivo"] == "atrasada"

    ainda_avisa = requests.get(f"{BASE_URL}/assinatura/status", headers=cliente["headers"]).json()
    assert ainda_avisa["aviso"] is not None, "sem pausa, o aviso normal tem que aparecer"

    pausar = requests.put(
        f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pausar-aviso",
        headers=admin["headers"], json={"ate": "2026-12-31"},
    )
    assert pausar.status_code == 200, pausar.text
    assert pausar.json()["status_efetivo"] == "atrasada", "pausa nao pode mexer no status real"

    sem_aviso = requests.get(f"{BASE_URL}/assinatura/status", headers=cliente["headers"]).json()
    assert sem_aviso["aviso"] is None, "com a pausa ativa, o cliente nao pode ver nada"

    listagem = requests.get(f"{BASE_URL}/plataforma/empresas", headers=admin["headers"]).json()
    linha = next(e for e in listagem["empresas"] if e["empresa_id"] == cliente["empresa_id"])
    assert linha["assinatura"]["status_efetivo"] == "atrasada", "no painel do dono continua atrasada, mesmo pausada"


def test_pausar_aviso_pode_ser_cancelado_antes_do_prazo():
    admin = criar_empresa("Admin Cancela Pausa")
    promover_admin(admin["email"])
    cliente = criar_empresa("Cliente Cancela Pausa")

    criada = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"valor": 150, "dia_vencimento": 10, "proximo_vencimento": "2026-08-01"},
    ).json()
    requests.put(f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pausar-aviso", headers=admin["headers"], json={"ate": "2026-12-31"})

    retomar = requests.put(f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pausar-aviso", headers=admin["headers"], json={"ate": None})
    assert retomar.status_code == 200, retomar.text

    de_volta = requests.get(f"{BASE_URL}/assinatura/status", headers=cliente["headers"]).json()
    assert de_volta["aviso"] is not None, "cancelar a pausa tem que trazer o aviso de volta na hora"


def test_pausar_aviso_so_admin_e_valida_formato_da_data():
    admin = criar_empresa("Admin Valida Pausa")
    promover_admin(admin["email"])
    outro = criar_empresa("Outro Nao Admin Pausa")
    cliente = criar_empresa("Cliente Valida Pausa")

    criada = requests.put(
        f"{BASE_URL}/plataforma/empresas/{cliente['empresa_id']}/assinatura",
        headers=admin["headers"],
        json={"valor": 100, "dia_vencimento": 10, "proximo_vencimento": "2026-08-01"},
    ).json()

    negado = requests.put(f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pausar-aviso", headers=outro["headers"], json={"ate": "2026-12-31"})
    assert negado.status_code == 403

    invalido = requests.put(f"{BASE_URL}/plataforma/assinaturas/{criada['id']}/pausar-aviso", headers=admin["headers"], json={"ate": "31/12/2026"})
    assert invalido.status_code == 400


def test_admin_nao_precisa_pertencer_a_empresa_nenhuma_para_ver_tudo():
    """`listTodas`/`list()` sao cross-tenant de proposito - o admin enxerga
    TODAS as empresas, nao so a propria."""
    admin = criar_empresa("Admin Ve Tudo")
    promover_admin(admin["email"])
    criar_empresa("Empresa Visivel 1")
    criar_empresa("Empresa Visivel 2")

    r = requests.get(f"{BASE_URL}/plataforma/empresas", headers=admin["headers"])
    assert r.status_code == 200
    nomes = {e["nome"] for e in r.json()["empresas"]}
    assert "Empresa Visivel 1" in nomes
    assert "Empresa Visivel 2" in nomes
    assert "resumo" in r.json()


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
