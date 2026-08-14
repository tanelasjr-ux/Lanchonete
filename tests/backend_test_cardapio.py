import os
import pytest
import requests
from urllib.parse import quote

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

def test_cardapio_empresa_valida():
    """Cardápio de empresa válida retorna produtos e categorias."""
    signup = requests.post(f"{BASE_URL}/signup", json={"nome": "Test Cardapio", "email": f"test-cardapio-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa_id = signup["empresa_id"]
    token = signup["token"]
    headers = {"Authorization": f"Bearer {token}"}

    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    empresa_slug = empresa["slug"]

    cat = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas", "ordem": 1}, headers=headers).json()
    cat_id = cat["id"]

    p1 = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Café", "descricao": "Quente", "preco": 5.0, "disponivel": True},
        headers=headers
    ).json()
    p2 = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat_id, "nome": "Chá Gelado", "descricao": "Frio", "preco": 8.0, "disponivel": False},
        headers=headers
    ).json()

    res = requests.get(f"{BASE_URL}/cardapio/{quote(empresa_slug)}")
    assert res.status_code == 200

    data = res.json()
    assert data["empresa"]["nome"] == empresa["nome_comercial"] or empresa["nome"]
    assert len(data["categorias"]) == 1
    assert data["categorias"][0]["nome"] == "Bebidas"

    assert len(data["produtos"]) == 1
    assert data["produtos"][0]["nome"] == "Café"
    assert data["produtos"][0]["preco"] == 5.0

def test_cardapio_empresa_nao_existe():
    """Slug inválido retorna 404."""
    res = requests.get(f"{BASE_URL}/cardapio/empresa-fantasma-{os.urandom(4).hex()}")
    assert res.status_code == 404

def test_cardapio_multitenant():
    """Duas empresas não veem as categorias/produtos uma da outra."""
    signup1 = requests.post(f"{BASE_URL}/signup", json={"nome": "Empresa A", "email": f"empA-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa1_id = signup1["empresa_id"]
    token1 = signup1["token"]
    headers1 = {"Authorization": f"Bearer {token1}"}

    empresa1 = requests.get(f"{BASE_URL}/empresa", headers=headers1).json()
    slug1 = empresa1["slug"]

    cat1 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Bebidas A", "ordem": 1}, headers=headers1).json()
    requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat1["id"], "nome": "Produto A", "preco": 10.0, "disponivel": True},
        headers=headers1
    )

    signup2 = requests.post(f"{BASE_URL}/signup", json={"nome": "Empresa B", "email": f"empB-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    empresa2_id = signup2["empresa_id"]
    token2 = signup2["token"]
    headers2 = {"Authorization": f"Bearer {token2}"}

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

    assert data1["categorias"][0]["nome"] == "Bebidas A"
    assert data1["produtos"][0]["nome"] == "Produto A"

    assert data2["categorias"][0]["nome"] == "Bebidas B"
    assert data2["produtos"][0]["nome"] == "Produto B"

def test_cardapio_sem_categoria():
    """Empresa com categorias mas zero produtos retorna array vazio."""
    signup = requests.post(f"{BASE_URL}/signup", json={"nome": "Test Empty", "email": f"empty-{os.urandom(4).hex()}@test.com", "senha": "senha123"}).json()
    token = signup["token"]
    headers = {"Authorization": f"Bearer {token}"}

    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]

    requests.post(f"{BASE_URL}/categorias", json={"nome": "Vazia", "ordem": 1}, headers=headers)

    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}")
    assert res.status_code == 200

    data = res.json()
    assert len(data["categorias"]) == 1
    assert len(data["produtos"]) == 0

if __name__ == '__main__':
    pytest.main([__file__, '-v'])
