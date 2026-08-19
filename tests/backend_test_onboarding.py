"""Onboarding guiado (B2): checklist de primeiros passos + seed de
demonstracao sob demanda.

Ate 2026-08-19 toda empresa nova nascia com dados ficticios (seed
automatico no signup), o que esvaziava o proposito de um checklist —
"cadastrar categoria"/"criar mesas" ja apareceriam prontos sem o dono ter
feito nada. `POST /auth/register` parou de semear sozinho; o seed virou
`POST /empresa/seed-demo`, sob demanda ("quero ver com dados de exemplo").
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


def test_empresa_nova_nasce_vazia_sem_seed_automatico():
    """Regressao direta: signup NAO pode mais rodar o seed de demonstracao
    sozinho. A empresa nasce sem categoria, produto, mesa ou transacao."""
    headers = criar_empresa("Onboarding Nasce Vazia")
    assert requests.get(f"{BASE_URL}/categorias", headers=headers).json() == []
    assert requests.get(f"{BASE_URL}/produtos", headers=headers).json() == []
    assert requests.get(f"{BASE_URL}/mesas", headers=headers).json() == []


def test_checklist_comeca_com_tudo_pendente():
    headers = criar_empresa("Onboarding Tudo Pendente")
    r = requests.get(f"{BASE_URL}/onboarding/status", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["completo"] is False
    chaves = {i["chave"] for i in body["itens"]}
    assert chaves == {"categoria", "produto_custo", "mesa", "venda"}
    assert all(i["feito"] is False for i in body["itens"])


def test_checklist_item_categoria_fecha_ao_cadastrar():
    headers = criar_empresa("Onboarding Categoria")
    requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Bebidas", "ordem": 1})
    r = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    item = next(i for i in r["itens"] if i["chave"] == "categoria")
    assert item["feito"] is True
    assert r["completo"] is False, "os outros itens continuam pendentes"


def test_checklist_produto_so_fecha_com_custo_preenchido():
    """Produto SEM custo nao fecha o item — e o proposito do B2: guiar o
    dono a cadastrar o custo, nao so um produto qualquer (o seed antigo
    tambem nao preenchia custo nos produtos de exemplo, de proposito)."""
    headers = criar_empresa("Onboarding Produto Custo")
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()

    requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Sem Custo", "preco": 20, "categoria_id": cat["id"],
    })
    sem_custo = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    assert next(i for i in sem_custo["itens"] if i["chave"] == "produto_custo")["feito"] is False

    requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Com Custo", "preco": 20, "custo": 8, "categoria_id": cat["id"],
    })
    com_custo = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    assert next(i for i in com_custo["itens"] if i["chave"] == "produto_custo")["feito"] is True


def test_checklist_omite_mesa_quando_modulo_desligado():
    headers = criar_empresa("Onboarding Sem Modulo Mesas")
    requests.put(f"{BASE_URL}/modulos/mesas", headers=headers, json={"ativo": False})
    r = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    assert "mesa" not in {i["chave"] for i in r["itens"]}, "sem o modulo, o item nao faz sentido"


def test_checklist_venda_fecha_so_com_transacao_de_receita():
    headers = criar_empresa("Onboarding Venda")
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Prato", "preco": 30, "custo": 10, "categoria_id": cat["id"],
    }).json()

    pedido = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "para_levar",
        "itens": [{"produto_id": prod["id"], "nome": prod["nome"], "preco": prod["preco"], "quantidade": 1}],
    }).json()
    requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})

    r = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    assert next(i for i in r["itens"] if i["chave"] == "venda")["feito"] is True


def test_checklist_completo_quando_os_quatro_itens_fecham():
    headers = criar_empresa("Onboarding Completo")
    cat = requests.post(f"{BASE_URL}/categorias", headers=headers, json={"nome": "Pratos", "ordem": 1}).json()
    prod = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": "Prato", "preco": 30, "custo": 10, "categoria_id": cat["id"],
    }).json()
    requests.post(f"{BASE_URL}/mesas/configurar", headers=headers, json={"quantidade": 4, "capacidade": 4})
    pedido = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "para_levar",
        "itens": [{"produto_id": prod["id"], "nome": prod["nome"], "preco": prod["preco"], "quantidade": 1}],
    }).json()
    requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})

    r = requests.get(f"{BASE_URL}/onboarding/status", headers=headers).json()
    assert r["completo"] is True, r


def test_seed_demo_cria_dados_e_fecha_o_checklist():
    headers = criar_empresa("Onboarding Seed Demo")
    r = requests.post(f"{BASE_URL}/empresa/seed-demo", headers=headers)
    assert r.status_code == 200, r.text

    categorias = requests.get(f"{BASE_URL}/categorias", headers=headers).json()
    produtos = requests.get(f"{BASE_URL}/produtos", headers=headers).json()
    mesas = requests.get(f"{BASE_URL}/mesas", headers=headers).json()
    assert len(categorias) == 4
    assert len(produtos) == 11
    assert len(mesas) == 8


def test_seed_demo_nao_roda_duas_vezes():
    headers = criar_empresa("Onboarding Seed Duplo")
    primeiro = requests.post(f"{BASE_URL}/empresa/seed-demo", headers=headers)
    assert primeiro.status_code == 200

    segundo = requests.post(f"{BASE_URL}/empresa/seed-demo", headers=headers)
    assert segundo.status_code == 409, "empresa ja tem categoria, nao pode semear de novo"

    produtos = requests.get(f"{BASE_URL}/produtos", headers=headers).json()
    assert len(produtos) == 11, "nao pode ter duplicado o seed"


def test_seed_demo_bloqueado_para_quem_nao_e_owner_admin():
    admin_headers = criar_empresa("Onboarding Seed Permissao")
    r = requests.post(f"{BASE_URL}/usuarios", headers=admin_headers, json={
        "nome": "Atendente", "email": f"at-{os.urandom(4).hex()}@test.com",
        "senha": "senha123", "papel": "ATENDENTE",
    })
    assert r.status_code == 201, r.text
    login = requests.post(f"{BASE_URL}/auth/login", json={"email": r.json()["email"], "senha": "senha123"})
    at_headers = {"Authorization": f"Bearer {login.json()['token']}"}

    negado = requests.post(f"{BASE_URL}/empresa/seed-demo", headers=at_headers)
    assert negado.status_code == 403


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
