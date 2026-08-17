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


# PNG 1x1 valido (o menor arquivo real que passa pela validacao de mimetype
# do storage.js sem precisar de biblioteca de imagem no teste).
_PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415478da6360606060000000050001a5f645400000000049454e44ae426082"
)


def test_cardapio_imagem_upload_e_exposta():
    """Upload da imagem do cardapio aparece no endpoint publico.

    Espelha a suite de logo (nao existe uma neste projeto ainda, mas o padrao
    de storage e identico) — POST multipart, URL publica volta na resposta e
    no GET /cardapio/:slug seguinte.
    """
    headers = criar_empresa("Test Cardapio Imagem")
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]

    res_antes = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}").json()
    assert res_antes["empresa"]["cardapio_imagem_url"] is None

    r = requests.post(
        f"{BASE_URL}/empresa/cardapio-imagem",
        headers=headers,
        files={"arquivo": ("cardapio.png", _PNG_1X1, "image/png")},
    )
    assert r.status_code == 200, r.text
    url = r.json()["cardapio_imagem_url"]
    assert url and "cardapios" in url

    res_depois = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}").json()
    assert res_depois["empresa"]["cardapio_imagem_url"] == url


def test_cardapio_imagem_remocao_volta_ao_modo_lista():
    """DELETE remove a imagem; o publico volta a ver cardapio_imagem_url null."""
    headers = criar_empresa("Test Cardapio Remove")
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]

    requests.post(
        f"{BASE_URL}/empresa/cardapio-imagem",
        headers=headers,
        files={"arquivo": ("cardapio.png", _PNG_1X1, "image/png")},
    )
    r = requests.delete(f"{BASE_URL}/empresa/cardapio-imagem", headers=headers)
    assert r.status_code == 200
    assert r.json()["cardapio_imagem_url"] is None

    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}").json()
    assert res["empresa"]["cardapio_imagem_url"] is None


def test_cardapio_imagem_formato_invalido_rejeitado():
    """Formato fora da lista permitida (PNG/JPG/WEBP) retorna 400, nunca 200."""
    headers = criar_empresa("Test Cardapio Formato")
    r = requests.post(
        f"{BASE_URL}/empresa/cardapio-imagem",
        headers=headers,
        files={"arquivo": ("cardapio.gif", b"GIF89a", "image/gif")},
    )
    assert r.status_code == 400


def test_cardapio_imagem_exige_autenticacao():
    """Sem token, upload/remocao da imagem do cardapio sao recusados."""
    r = requests.post(
        f"{BASE_URL}/empresa/cardapio-imagem",
        files={"arquivo": ("cardapio.png", _PNG_1X1, "image/png")},
    )
    assert r.status_code == 401


def test_cardapio_indisponiveis_hoje():
    """Produto marcado indisponivel some da lista e aparece em indisponiveis_hoje.

    Reaproveita o campo `disponivel` ja existente (toggle "Em Falta" do
    cardapio) — nao e um campo novo, so uma nova leitura dele no endpoint
    publico, pensada para o modo imagem (onde nao da pra "tirar" o item de
    uma foto estatica).
    """
    headers = criar_empresa("Test Indisponivel Hoje")
    empresa = requests.get(f"{BASE_URL}/empresa", headers=headers).json()
    slug = empresa["slug"]

    cat = requests.post(f"{BASE_URL}/categorias", json={"nome": "Pratos QA", "ordem": 99}, headers=headers).json()
    prod = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat["id"], "nome": "Feijoada QA", "preco": 30.0, "disponivel": True},
        headers=headers,
    ).json()

    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}").json()
    assert "Feijoada QA" in [p["nome"] for p in res["produtos"]]
    assert "Feijoada QA" not in res["indisponiveis_hoje"]

    requests.put(f"{BASE_URL}/produtos/{prod['id']}", json={"disponivel": False}, headers=headers)

    res = requests.get(f"{BASE_URL}/cardapio/{quote(slug)}").json()
    assert "Feijoada QA" not in [p["nome"] for p in res["produtos"]], "indisponivel nao deve aparecer na lista"
    assert "Feijoada QA" in res["indisponiveis_hoje"], "indisponivel deve aparecer no banner"


def test_cardapio_imagem_e_indisponiveis_multitenant():
    """Imagem e lista de indisponiveis de uma empresa nunca vazam para outra."""
    headers1 = criar_empresa("Cardapio Img Multi A")
    empresa1 = requests.get(f"{BASE_URL}/empresa", headers=headers1).json()
    slug1 = empresa1["slug"]

    cat1 = requests.post(f"{BASE_URL}/categorias", json={"nome": "Cat Multi A", "ordem": 99}, headers=headers1).json()
    prod1 = requests.post(
        f"{BASE_URL}/produtos",
        json={"categoria_id": cat1["id"], "nome": "Produto Indisp A", "preco": 15.0, "disponivel": True},
        headers=headers1,
    ).json()
    requests.put(f"{BASE_URL}/produtos/{prod1['id']}", json={"disponivel": False}, headers=headers1)
    requests.post(
        f"{BASE_URL}/empresa/cardapio-imagem",
        headers=headers1,
        files={"arquivo": ("cardapio.png", _PNG_1X1, "image/png")},
    )

    headers2 = criar_empresa("Cardapio Img Multi B")
    empresa2 = requests.get(f"{BASE_URL}/empresa", headers=headers2).json()
    slug2 = empresa2["slug"]

    res2 = requests.get(f"{BASE_URL}/cardapio/{quote(slug2)}").json()
    assert res2["empresa"]["cardapio_imagem_url"] is None, "empresa B nao pode herdar a imagem de A"
    assert "Produto Indisp A" not in res2["indisponiveis_hoje"], "empresa B nao pode herdar indisponiveis de A"

    res1 = requests.get(f"{BASE_URL}/cardapio/{quote(slug1)}").json()
    assert res1["empresa"]["cardapio_imagem_url"] is not None


if __name__ == '__main__':
    # `raise SystemExit(...)` propaga o codigo do pytest. Sem isso a suite
    # sempre sai com 0 e o runner reporta verde mesmo com teste falhando.
    raise SystemExit(pytest.main([__file__, '-v']))
