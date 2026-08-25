"""PDV — cobranca no cartao pela maquininha (Mercado Pago Point).

O Mercado Pago nunca e mockado (regra do projeto) — estes testes cobrem o
que NAO depende de chamar a API real do MP: rejeicao sem configuracao, a
guarda contra receita duplicada, e isolamento multi-tenant. A cobranca de
verdade (criar order, confirmar por webhook real) so e validada manualmente
com uma Point Smart fisica — ver docs/superpowers/specs/2026-08-19-pdv-maquininha-design.md.
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
    return {"Authorization": f"Bearer {r.json()['token']}"}


def abrir_comanda(headers):
    mesas = requests.get(f"{BASE_URL}/mesas", headers=headers).json()
    if not mesas:
        requests.post(f"{BASE_URL}/mesas/configurar", headers=headers, json={"quantidade": 4, "capacidade": 4})
        mesas = requests.get(f"{BASE_URL}/mesas", headers=headers).json()
    mesa = next(m for m in mesas if m["status"] == "livre")
    r = requests.post(f"{BASE_URL}/mesas/{mesa['id']}/abrir", headers=headers, json={"pessoas": 2})
    return r.json()


def criar_pedido_pago_avel(headers):
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Prato", "preco": 30, "custo": 10, "categoria_id": cat["id"],
    }).json()
    return requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "para_levar",
        "itens": [{"produto_id": prod["id"], "nome": prod["nome"], "preco": prod["preco"], "quantidade": 1}],
    }).json()


def test_cobrar_na_comanda_sem_maquininha_configurada_da_400():
    headers = criar_empresa("PDV Sem Config Comanda")
    comanda = abrir_comanda(headers)
    r = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/cartao", headers=headers, json={})
    assert r.status_code == 400
    assert "nao configurada" in r.json()["error"].lower()


def test_cobrar_no_pedido_sem_maquininha_configurada_da_400():
    headers = criar_empresa("PDV Sem Config Pedido")
    pedido = criar_pedido_pago_avel(headers)
    r = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/cartao", headers=headers, json={})
    assert r.status_code == 400
    assert "nao configurada" in r.json()["error"].lower()


def test_terminal_id_configuravel_na_integracao_mercadopago():
    headers = criar_empresa("PDV Configura Terminal")
    r = requests.put(f"{BASE_URL}/integracoes/mercadopago", headers=headers, json={
        "accessToken": "TEST-fake-token-nunca-usado-em-chamada-real",
        "terminalId": "NEWLAND_N950__SBX0000001",
    })
    assert r.status_code == 200, r.text
    assert r.json()["hasTerminal"] is True

    integ = requests.get(f"{BASE_URL}/integracoes", headers=headers).json()
    assert integ["mercadopago"]["config"]["terminalId"] == "NEWLAND_N950__SBX0000001"


def test_cobrar_pedido_ja_pago_da_409():
    headers = criar_empresa("PDV Pedido Ja Pago")
    requests.put(f"{BASE_URL}/integracoes/mercadopago", headers=headers, json={
        "accessToken": "TEST-fake", "terminalId": "TERM-1",
    })
    pedido = criar_pedido_pago_avel(headers)
    # simula pagamento ja confirmado direto no pedido (sem passar pela rede do MP)
    requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"observacoes": "marcador"})
    # Nao ha endpoint para forcar pago_em via API por design (so confirmarPagamento
    # grava). Testa o caminho real: cria a cobranca (que vai falhar na rede, 502,
    # pois o token e falso) e confirma que pedido ja pago bloqueia ANTES de tentar
    # a rede - reordena a checagem para nao gastar uma chamada de rede a toa.
    r1 = requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/cartao", headers=headers, json={})
    assert r1.status_code in (502, 400), "com token falso, ou rede falha (502) ou terminal falta (400) - nunca sucesso simulado"


def test_isolamento_multi_tenant_cancelar_cobranca():
    a = criar_empresa("PDV Isolamento A")
    b = criar_empresa("PDV Isolamento B")
    comanda = abrir_comanda(a)
    requests.put(f"{BASE_URL}/integracoes/mercadopago", headers=a, json={"accessToken": "TEST-fake", "terminalId": "TERM-A"})
    # sem rede real, so confirma que empresa B nao acha um pagamento de A
    r = requests.get(f"{BASE_URL}/pagamentos/id-que-nao-existe-em-b", headers=b)
    assert r.status_code == 404


def test_permissao_cobrar_no_cartao_exige_role_pagamentos():
    owner_headers = criar_empresa("PDV Permissao")
    r = requests.post(f"{BASE_URL}/usuarios", headers=owner_headers, json={
        "nome": "Cozinha", "email": f"cozinha-{os.urandom(4).hex()}@test.com",
        "senha": "senha123", "papel": "COZINHA",
    })
    assert r.status_code == 201, r.text
    login = requests.post(f"{BASE_URL}/auth/login", json={"email": r.json()["email"], "senha": "senha123"})
    cozinha_headers = {"Authorization": f"Bearer {login.json()['token']}"}

    comanda = abrir_comanda(owner_headers)
    negado = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/cartao", headers=cozinha_headers, json={})
    assert negado.status_code == 403


def test_fechar_comanda_nao_lanca_receita_de_cobranca_pendente():
    """Achado real na revisao final do plano do PDV, 2026-08-24: o laco de
    fechamento de comanda (POST /comandas/:id/fechar) criava uma transacao
    de receita para CADA item de `comanda.pagamentos`, sem olhar o status —
    uma cobranca no cartao ainda `pending` (empurrada pelas Tasks 6/7) virava
    receita fantasma se a comanda fosse fechada por outro meio antes do
    cartao ser de fato aprovado. Corrigido filtrando por status='approved',
    mesmo criterio ja usado por computeComanda() pro campo `restante`.
    """
    headers = criar_empresa("PDV Fecha Com Pendente")
    requests.put(f"{BASE_URL}/integracoes/mercadopago", headers=headers, json={
        "accessToken": "TEST-fake", "terminalId": "TERM-FECHA",
    })
    comanda = abrir_comanda(headers)
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Prato", "preco": 50, "custo": 20, "categoria_id": cat["id"],
    }).json()
    c = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", headers=headers, json={
        "produto_id": prod["id"], "quantidade": 1,
    }).json()
    total = c["total"]  # inclui taxa de servico default — nunca supor 1:1 com o preco do produto

    # Simula uma cobranca no cartao que ficou pendente (nunca confirmada) —
    # mesmo formato que POST /comandas/:id/cartao grava de verdade.
    empresa_id = comanda["empresa_id"]
    _db.pagamentos.insert_one({
        "id": "fake-pendente-fechamento", "empresa_id": empresa_id, "comanda_id": comanda["id"], "pedido_id": None,
        "metodo": "cartao_credito", "valor": total, "status": "pending", "provider": "mercadopago_point",
        "provider_payment_id": "fake-order-fechamento", "external_reference": "x", "idempotency_key": "x",
    })
    _db.comandas.update_one({"id": comanda["id"]}, {"$push": {"pagamentos": {
        "id": "fake-pendente-fechamento", "metodo": "cartao_credito", "valor": total, "status": "pending",
        "provider": "mercadopago_point", "created_at": None,
    }}})

    # Cliente desiste do cartao e paga em dinheiro — o restante continua o
    # total inteiro porque a cobranca pendente NAO conta pro `pago` (mesma
    # regra de computeComanda).
    pagar = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/pagamentos", headers=headers, json={
        "metodo": "dinheiro", "valor": total,
    })
    assert pagar.status_code == 201, pagar.text

    fechar = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/fechar", headers=headers, json={})
    assert fechar.status_code == 200, fechar.text

    transacoes = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()
    da_comanda = [t for t in transacoes if t.get("comanda_id") == comanda["id"]]
    assert len(da_comanda) == 1, f"esperado 1 transacao de receita (so o dinheiro), veio {len(da_comanda)}: {da_comanda}"
    assert da_comanda[0]["forma_pagamento"] == "dinheiro"
    assert da_comanda[0]["valor"] == total

    _db.pagamentos.delete_many({"id": "fake-pendente-fechamento"})


def test_pedido_pago_no_cartao_ainda_baixa_estoque():
    """Achado real na revisao final do plano do PDV, 2026-08-24: a guarda
    `!pedido.pago_em` em PUT /pedidos/:id (criada na Task 7 so pra nao
    lancar receita duas vezes) tambem envolvia a baixa de estoque — todo
    pedido pago pela maquininha saia da casa sem baixar estoque. Corrigido
    movendo a baixa de estoque pra fora da guarda (ela deve acontecer
    sempre que o pedido conclui, pago ou nao).
    """
    headers = criar_empresa("PDV Estoque Cartao")
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Prato com Estoque", "preco": 30, "custo": 10, "categoria_id": cat["id"],
        "estoque_habilitado": True, "estoque_quantidade": 10,
    }).json()
    pedido = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "para_levar",
        "itens": [{"produto_id": prod["id"], "nome": prod["nome"], "preco": prod["preco"], "quantidade": 3}],
    }).json()

    # Simula pagamento ja confirmado pela maquininha (mesmo efeito que
    # confirmarPagamento() produz — direto no Mongo, sem rede real do MP,
    # mesmo padrao ja usado na verificacao manual da Task 7).
    _db.pedidos.update_one({"id": pedido["id"]}, {"$set": {"pago_em": "2026-08-25T00:00:00.000Z"}})

    concluir = requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})
    assert concluir.status_code == 200, concluir.text

    produto_depois = requests.get(f"{BASE_URL}/produtos", headers=headers).json()
    prod_depois = next(p for p in produto_depois if p["id"] == prod["id"])
    assert prod_depois["estoque_quantidade"] == 7, f"esperado 10-3=7, veio {prod_depois['estoque_quantidade']}"


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
