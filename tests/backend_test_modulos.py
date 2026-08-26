"""Feature flags que realmente controlam acesso (B1 do programa de profissionalizacao).

Ate 2026-08-18 as flags eram decorativas: existiam no banco, apareciam na tela,
e nenhum dos 81 endpoints as consultava. Desligar "Estoque" nao desligava o
Estoque. Estes testes existem para que isso nao volte em silencio — se alguem
criar uma rota de caixa nova sem o portao, o teste de isolamento acusa.
"""
import os
import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

_db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))[os.environ.get("DB_NAME", "restaurant_os_dev")]


def promover_completo(conta):
    """Uso so em dev local (Mongo) — mesmo espirito de promover_admin() em
    backend_test_plataforma.py. So prova algo contra DATABASE_PROVIDER=mongo."""
    _db.empresas.update_one({"id": conta["empresa_id"]}, {"$set": {"config.plano": "completo"}})


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


def desligar(headers, modulo):
    r = requests.put(f"{BASE_URL}/modulos/{modulo}", headers=headers, json={"ativo": False})
    assert r.status_code == 200, f"nao consegui desligar {modulo}: {r.status_code} {r.text}"
    return r.json()


def ligar(headers, modulo):
    r = requests.put(f"{BASE_URL}/modulos/{modulo}", headers=headers, json={"ativo": True})
    assert r.status_code == 200, r.text
    return r.json()


def test_signup_liga_os_modulos_que_o_produto_entrega():
    """Empresa nova nasce no plano Basico: mesas sempre ligada, Estoque e
    Caixa BLOQUEADOS pelo plano (nao pela flag, que continua True por
    padrao — ver test_modulo_futuro_nasce_fechado_no_signup para o
    equivalente dos modulos sem implementacao).
    """
    conta = criar_empresa("Signup Flags")
    r = requests.get(f"{BASE_URL}/modulos", headers=conta["headers"])
    assert r.status_code == 200
    ativos = {m["chave"]: m["ativo"] for m in r.json()["disponiveis"]}

    assert ativos["mesas"] is True
    assert ativos["estoque"] is False, "plano Basico nao inclui Estoque"
    assert ativos["caixa"] is False, "plano Basico nao inclui Caixa"
    assert ativos["financeiro"] is False, "plano Basico nao inclui Financeiro"


def test_auth_me_expoe_modulos_resolvidos():
    """/auth/me devolve `modulos` pronto — o front nao reinterpreta as flags."""
    conta = criar_empresa("Auth Me Modulos")
    promover_completo(conta)
    headers = conta["headers"]
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
    conta = criar_empresa("Caixa Off")
    promover_completo(conta)
    headers = conta["headers"]
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
    conta = criar_empresa("Mesas Off")
    headers = conta["headers"]
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
    conta = criar_empresa("Estoque Off")
    promover_completo(conta)
    headers = conta["headers"]
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
    conta = criar_empresa("Religar")
    promover_completo(conta)
    headers = conta["headers"]
    requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 250})

    desligar(headers, "caixa")
    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers).status_code == 403

    ligar(headers, "caixa")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    assert r.status_code == 200
    assert r.json()["caixa"] is not None, "o caixa aberto antes do desligamento tem que continuar la"
    assert r.json()["caixa"]["valor_abertura"] == 250


def test_modulo_sem_implementacao_nao_e_configuravel():
    """PUT num modulo sem implementacao da 404 — nao existe o que ligar.

    Aceitar o PUT gravaria uma flag `crm: true` que nao habilita CRM nenhum:
    exatamente a classe de mentira que este trabalho removeu.
    """
    conta = criar_empresa("Sem Implementacao")
    headers = conta["headers"]
    r = requests.put(f"{BASE_URL}/modulos/crm", headers=headers, json={"ativo": True})
    assert r.status_code == 404

    # O catalogo lista SO o que da para configurar. A vitrine de "em breve"
    # saiu da tela e da resposta a pedido do dono.
    catalogo = requests.get(f"{BASE_URL}/modulos", headers=headers).json()
    assert {m["chave"] for m in catalogo["disponiveis"]} == {"mesas", "estoque", "caixa", "financeiro"}
    assert "em_breve" not in catalogo


def test_modulo_futuro_nasce_fechado_no_signup():
    """Modulo sem implementacao e gravado como `false`, nao omitido.

    `temModulo` trata flag ausente como LIGADA (para nao tirar acesso de quem
    ja usa). Se o signup simplesmente nao registrasse `crm`, o dia em que o CRM
    ganhasse portao ele nasceria aberto para todo mundo. O `false` explicito e
    o que mantem a porta fechada.
    """
    conta = criar_empresa("Futuro Fechado")
    headers = conta["headers"]
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    flags = empresa["config"]["feature_flags"]

    for chave in ("crm", "campanhas", "fidelidade", "cashback", "multiunidade", "billing"):
        assert flags.get(chave) is False, f"{chave} deveria nascer False explicito, veio {flags.get(chave)!r}"


def test_modulo_de_uma_empresa_nao_afeta_outra():
    """Desligar caixa na empresa A nao pode desligar na empresa B."""
    conta_a = criar_empresa("Modulo Multi A")
    conta_b = criar_empresa("Modulo Multi B")
    promover_completo(conta_a)
    promover_completo(conta_b)
    headers_a = conta_a["headers"]
    headers_b = conta_b["headers"]

    desligar(headers_a, "caixa")

    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers_a).status_code == 403
    assert requests.get(f"{BASE_URL}/caixa/atual", headers=headers_b).status_code == 200


def test_papel_sem_permissao_nao_configura_modulo():
    """Portao de plano e portao de papel sao independentes e ambos valem.

    Um ATENDENTE nao decide o que a empresa contratou — mesmo que a empresa
    tenha o modulo, mexer no interruptor e de OWNER/ADMIN.
    """
    conta_owner = criar_empresa("Papel Modulo")
    promover_completo(conta_owner)
    headers_owner = conta_owner["headers"]
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


def test_signup_cria_assinatura_automatica_no_basico():
    """Empresa nova nasce com uma assinatura formal (plano basico), nao no limbo.

    Antes desta mudanca, `assinaturas` ficava vazia ate o dono da ETNA
    configurar manualmente pelo Painel — a empresa existia sem nenhum
    registro de plano.
    """
    conta = criar_empresa("Signup Assinatura")
    headers = conta["headers"]
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    assert empresa["config"]["plano"] == "basico", "config.plano deveria nascer 'basico'"


def test_signup_nasce_basico_estoque_e_caixa_bloqueados():
    """Mudanca de comportamento INTENCIONAL: com plano formal, uma empresa
    nova nasce no Basico, entao Estoque/Caixa (que exigem Completo) vem
    BLOQUEADOS mesmo com a flag ligada — nao mais liberados por padrao.
    """
    conta = criar_empresa("Signup Basico Bloqueado")
    headers = conta["headers"]
    r = requests.get(f"{BASE_URL}/modulos", headers=headers)
    ativos = {m["chave"]: m["ativo"] for m in r.json()["disponiveis"]}
    assert ativos["estoque"] is False, "Basico nao inclui Estoque"
    assert ativos["caixa"] is False, "Basico nao inclui Caixa"
    assert ativos["financeiro"] is False, "Basico nao inclui Financeiro"
    assert ativos["mesas"] is True, "Mesas nunca e restringido por plano"


def test_basico_nao_liga_estoque_pelo_toggle():
    """Dono no plano Basico tenta ligar Estoque pelo interruptor -> 403.

    Desligar continua sempre livre — so LIGAR fora do plano e' bloqueado.
    """
    conta = criar_empresa("Basico Nao Liga Estoque")
    headers = conta["headers"]
    # Estoque ja nasce desligado no plano Basico (Task 3) — confirma o
    # estado de partida antes de tentar ligar.
    ativos = {m["chave"]: m["ativo"] for m in requests.get(f"{BASE_URL}/modulos", headers=headers).json()["disponiveis"]}
    assert ativos["estoque"] is False

    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": True})
    assert r.status_code == 403
    assert "plano" in r.json()["error"].lower()

    # Confirma que a tentativa nao teve efeito colateral nenhum na flag.
    ativos_depois = {m["chave"]: m["ativo"] for m in requests.get(f"{BASE_URL}/modulos", headers=headers).json()["disponiveis"]}
    assert ativos_depois["estoque"] is False


def test_desligar_sempre_funciona_mesmo_fora_do_plano():
    """Basico tentando DESLIGAR um modulo que ja esta desligado (por plano)
    nao pode dar erro estranho — a acao e' um no-op seguro, nao um 403.
    """
    conta = criar_empresa("Basico Desliga Sem Erro")
    headers = conta["headers"]
    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": False})
    assert r.status_code == 200, r.text


def test_completo_liga_estoque_pelo_toggle_normalmente():
    """Empresa no Completo continua podendo ligar/desligar Estoque livremente
    — a trava e' so contra ligar algo que o plano nao cobre.
    """
    conta = criar_empresa("Completo Liga Estoque")
    headers = conta["headers"]
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    empresa_id = empresa["id"]

    admin = criar_empresa("Admin Promove Completo")
    from pymongo import MongoClient
    db = MongoClient("mongodb://localhost:27017")["restaurant_os_dev"]
    db.plataforma_admins.insert_one({"email": admin["email"], "nome": "Admin Teste", "ativo": True})
    requests.put(
        f"{BASE_URL}/plataforma/empresas/{empresa_id}/assinatura",
        headers=admin["headers"],
        json={"plano": "completo", "valor": 200, "dia_vencimento": 10, "proximo_vencimento": "2026-12-01"},
    )
    db.plataforma_admins.delete_many({"email": admin["email"]})

    r = requests.put(f"{BASE_URL}/modulos/estoque", headers=headers, json={"ativo": True})
    assert r.status_code == 200, r.text


def test_financeiro_desligado_bloqueia_todas_as_rotas_financeiras():
    """Mesmo padrao de test_caixa_desligado_bloqueia_todas_as_rotas_de_caixa
    — modulo desligado (por nascer no Basico) barra TODAS as rotas
    financeiras, nao so a primeira.
    """
    conta = criar_empresa("Financeiro Off")
    headers = conta["headers"]

    for metodo, rota, corpo in [
        ("GET", "/financeiro/transacoes", None),
        ("GET", "/financeiro/categorias-despesa", None),
        ("POST", "/financeiro/transacoes", {"tipo": "receita", "valor": 10}),
        ("GET", "/financeiro/resumo", None),
        ("GET", "/contas", None),
        ("POST", "/contas", {"tipo": "pagar", "descricao": "x", "categoria": "Outros", "valor": 10, "vencimento": "2026-12-01"}),
        ("GET", "/financeiro/relatorio", None),
    ]:
        r = requests.request(metodo, f"{BASE_URL}{rota}", headers=headers, json=corpo)
        assert r.status_code == 403, f"{metodo} {rota} deveria dar 403 no plano Basico, deu {r.status_code}: {r.text}"


def test_get_modulos_expoe_disponivel_no_plano():
    """UI precisa distinguir 'desligado por escolha' de 'bloqueado pelo plano'
    para mostrar o botao certo (toggle vs. call-to-action de upgrade)."""
    conta = criar_empresa("Modulos Expoe Plano")
    r = requests.get(f"{BASE_URL}/modulos", headers=conta["headers"])
    por_chave = {m["chave"]: m for m in r.json()["disponiveis"]}

    assert por_chave["mesas"]["disponivelNoPlano"] is True
    assert por_chave["estoque"]["disponivelNoPlano"] is False, "Basico nao inclui Estoque"


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
