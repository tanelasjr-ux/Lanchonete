import os
import pytest
import requests
from urllib.parse import quote

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def criar_empresa(nome):
    """Cria empresa + usuario OWNER via /auth/register e devolve headers autenticados.

    O endpoint real e /auth/register, nao /signup (que nunca existiu no
    backend) — as quatro chamadas deste arquivo usavam /signup e assumiam um
    corpo de resposta {token, empresa_id} que tambem nunca existiu; o formato
    real e {token, usuario, empresa}. Corrigido em 2026-08-14 apos a primeira
    execucao real da suite (A1 do programa de profissionalizacao).
    """
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    dados = r.json()
    return {"Authorization": f"Bearer {dados['token']}"}


def test_cardapio_empresa_valida():
    """Cardápio de empresa válida retorna produtos e categorias.

    Empresa nova ja nasce com 4 categorias e 11 produtos do seed de
    demonstracao (seedEmpresa() em route.js, todos disponivel=true), entao o
    cardapio publico nunca esta vazio de verdade. O teste usa um nome de
    categoria que nao colide com o seed (Entradas/Pratos Principais/Bebidas/
    Sobremesas) e verifica PRESENCA dos itens criados aqui, nao a contagem
    total — contar tudo quebraria a cada produto que o seed ganhar no futuro.
    """
    headers = criar_empresa("Test Cardapio")

    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    empresa_slug = empresa["slug"]

    cat = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas Quentes QA", "ordem": 99}, headers=headers).json()
    cat_id = cat["id"]

    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Café QA", "descricao": "Quente", "preco": 5.0, "disponivel": True},
        headers=headers
    )
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Chá Gelado QA", "descricao": "Frio", "preco": 8.0, "disponivel": False},
        headers=headers
    )

    res = requests.get(f"{BASE_URL}/cardapio/{quote(empresa_slug)}")
    assert res.status_code == 200

    data = res.json()
    assert data["empresa"]["nome"] == empresa["nome_comercial"] or empresa["nome"]

    nomes_categorias = [c["nome"] for c in data["categorias"]]
    assert "Bebidas Quentes QA" in nomes_categorias

    produtos_por_nome = {p["nome"]: p for p in data["produtos"]}
    assert "Café QA" in produtos_por_nome, "produto disponivel deve aparecer"
    assert produtos_por_nome["Café QA"]["preco"] == 5.0
    assert "Chá Gelado QA" not in produtos_por_nome, "produto indisponivel nao deve aparecer"

def test_cardapio_empresa_nao_existe():
    """Slug inválido retorna 404."""
    res = requests.get(f"{BASE_URL}/cardapio/empresa-fantasma-{os.urandom(4).hex()}")
    assert res.status_code == 404

def test_cardapio_multitenant():
    """Duas empresas não veem as categorias/produtos uma da outra."""
    headers1 = criar_empresa("Empresa A")

    empresa1 = requests.get(f"{BASE_URL}/empresa", headers=headers1).json()
    slug1 = empresa1["slug"]

    cat1 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas A", "ordem": 1}, headers=headers1).json()
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat1["id"], "nome": "Produto A", "preco": 10.0, "disponivel": True},
        headers=headers1
    )

    headers2 = criar_empresa("Empresa B")

    empresa2 = requests.get(f"{BASE_URL}/empresa", headers=headers2).json()
    slug2 = empresa2["slug"]

    cat2 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas B", "ordem": 1}, headers=headers2).json()
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat2["id"], "nome": "Produto B", "preco": 20.0, "disponivel": True},
        headers=headers2
    )

    res1 = requests.get(f"{BASE_URL}/cardapio/{quote(slug1)}")
    res2 = requests.get(f"{BASE_URL}/cardapio/{quote(slug2)}")

    assert res1.status_code == 200
    assert res2.status_code == 200

    data1 = res1.json()
    data2 = res2.json()

    # Presenca, nao indice [0]: o seed de demonstracao ja povoa 4 categorias
    # (ordem 1-4) antes desta rodar (ordem 1 tambem, sem colidir em nome), entao
    # a categoria do teste nao e garantidamente a primeira da lista.
    nomes1 = [c["nome"] for c in data1["categorias"]]
    nomes2 = [c["nome"] for c in data2["categorias"]]
    produtos1 = [p["nome"] for p in data1["produtos"]]
    produtos2 = [p["nome"] for p in data2["produtos"]]

    assert "Bebidas A" in nomes1
    assert "Produto A" in produtos1
    assert "Bebidas B" in nomes2
    assert "Produto B" in produtos2

    # O isolamento de verdade: o que e da empresa B nunca aparece pra A.
    assert "Bebidas B" not in nomes1
    assert "Produto B" not in produtos1
    assert "Bebidas A" not in nomes2
    assert "Produto A" not in produtos2

def test_cardapio_sem_categoria():
    """Categoria sem nenhum produto aparece listada e sem itens ligados a ela.

    O nome original do teste ("array vazio") descrevia um cenario que o seed
    de demonstracao tornou impossivel — toda empresa nova ja tem 11 produtos.
    O que ainda e verificavel e o que importa de verdade: uma categoria pode
    existir e nao ter nenhum produto associado, e o endpoint reflete isso.
    """
    headers = criar_empresa("Test Empty")

    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]

    cat_vazia = requests.post(f"{BASE_URL}/categorias", json={"nome": "Vazia QA", "ordem": 99}, headers=headers).json()

    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}")
    assert res.status_code == 200

    data = res.json()
    nomes_categorias = [c["nome"] for c in data["categorias"]]
    assert "Vazia QA" in nomes_categorias

    produtos_da_vazia = [p for p in data["produtos"] if p.get("categoria_id") == cat_vazia["id"]]
    assert produtos_da_vazia == []

if __name__ == '__main__':
    # `raise SystemExit(...)` propaga o codigo do pytest. Sem isso a suite
    # sempre sai com 0 e o runner reporta verde mesmo com teste falhando.
    raise SystemExit(pytest.main([__file__, '-v']))
