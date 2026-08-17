"""Ranking de produtos por lucro bruto (margem por produto).

Responde "o que da lucro de verdade", nao o que vende mais. Usa o custo ATUAL
do produto (nao o congelado na venda) porque o custo so e congelado no nivel
da venda inteira, nao por item — mesma limitacao documentada em
computeMargemPorProduto.
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


def criar_produto(headers, nome, preco, custo=None):
    body = {"nome": nome, "preco": preco}
    if custo is not None:
        body["custo"] = custo
    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def vender(headers, itens, tipo="balcao"):
    """itens: lista de (produto, quantidade). Cria e conclui um pedido."""
    body = {
        "tipo": tipo, "cliente_nome": "Cliente Teste", "pagamento": "pix",
        "itens": [{"produto_id": p["id"], "preco": p["preco"], "quantidade": q} for p, q in itens],
    }
    r = requests.post(f"{BASE_URL}/pedidos", headers=headers, json=body)
    assert r.status_code == 201, r.text
    pedido = r.json()
    r2 = requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})
    assert r2.status_code == 200, r2.text
    return pedido


def relatorio(headers):
    r = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def produto_no_ranking(rep, produto_id):
    return next((p for p in rep["margem_por_produto"]["produtos"] if p["produto_id"] == produto_id), None)


def test_relatorio_devolve_margem_por_produto():
    headers = criar_empresa("Produto Existe")
    rep = relatorio(headers)
    assert "margem_por_produto" in rep
    assert "produtos" in rep["margem_por_produto"]


def test_lucro_bruto_e_receita_menos_custo():
    headers = criar_empresa("Lucro Produto")
    p = criar_produto(headers, "Combo Lucrativo", preco=40, custo=15)
    vender(headers, [(p, 3)])

    rep = relatorio(headers)
    item = produto_no_ranking(rep, p["id"])
    assert item is not None
    assert item["quantidade"] == 3
    assert item["receita"] == 120  # 3 x 40
    assert item["custo"] == 45     # 3 x 15
    assert item["lucro_bruto"] == 75
    assert item["margem_percent"] == 62.5  # (120-45)/120


def test_ranking_ordenado_por_lucro_bruto_decrescente():
    """O item de maior LUCRO fica primeiro, mesmo que outro venda mais unidades.

    E o ponto inteiro do relatorio: campeao de volume pode nao ser campeao de
    lucro.
    """
    headers = criar_empresa("Ranking Ordenado")
    volume_baixa_margem = criar_produto(headers, "Volume Baixa Margem", preco=10, custo=9)   # margem R$1/un
    nicho_alta_margem = criar_produto(headers, "Nicho Alta Margem", preco=50, custo=10)       # margem R$40/un

    vender(headers, [(volume_baixa_margem, 20)])  # lucro total: 20
    vender(headers, [(nicho_alta_margem, 2)])      # lucro total: 80

    rep = relatorio(headers)
    ranking = rep["margem_por_produto"]["produtos"]
    ids_no_topo = [p["produto_id"] for p in ranking if p["produto_id"] in (volume_baixa_margem["id"], nicho_alta_margem["id"])]
    assert ids_no_topo[0] == nicho_alta_margem["id"], \
        "produto de maior lucro total deveria vir primeiro, mesmo vendendo menos unidades"


def test_produto_sem_custo_cadastrado_da_null_nao_zero():
    headers = criar_empresa("Produto Sem Custo")
    p = criar_produto(headers, "Sem Custo Cadastrado", preco=25)  # sem `custo`
    vender(headers, [(p, 4)])

    rep = relatorio(headers)
    item = produto_no_ranking(rep, p["id"])
    assert item["receita"] == 100
    assert item["custo"] is None
    assert item["lucro_bruto"] is None
    assert item["margem_percent"] is None


def test_usa_custo_atual_nao_o_congelado_na_venda():
    """Vender com um custo, mudar o custo do produto, o ranking reflete o NOVO custo.

    Esta e a diferenca deliberada em relacao ao DRE/CMV do periodo (que usam o
    custo congelado na transacao). Documentar o comportamento evita que uma
    mudanca futura "corrija" isso sem perceber que era intencional.
    """
    headers = criar_empresa("Custo Muda")
    p = criar_produto(headers, "Custo Mutante", preco=100, custo=30)
    vender(headers, [(p, 1)])

    rep1 = relatorio(headers)
    item1 = produto_no_ranking(rep1, p["id"])
    assert item1["lucro_bruto"] == 70  # 100 - 30

    requests.put(f"{BASE_URL}/produtos/{p['id']}", headers=headers, json={"custo": 60})

    rep2 = relatorio(headers)
    item2 = produto_no_ranking(rep2, p["id"])
    assert item2["lucro_bruto"] == 40, "deveria refletir o custo ATUAL (60), nao o de quando vendeu (30)"


def test_mesma_venda_de_produtos_diferentes_soma_por_produto():
    """Dois pedidos com o mesmo produto somam quantidade e receita, nao duplicam linhas."""
    headers = criar_empresa("Soma Produto")
    p = criar_produto(headers, "Item Repetido", preco=20, custo=8)
    vender(headers, [(p, 2)])
    vender(headers, [(p, 5)])

    rep = relatorio(headers)
    ranking = [x for x in rep["margem_por_produto"]["produtos"] if x["produto_id"] == p["id"]]
    assert len(ranking) == 1, "produto vendido em pedidos diferentes deve aparecer numa unica linha"
    assert ranking[0]["quantidade"] == 7
    assert ranking[0]["receita"] == 140  # 7 x 20


def test_produto_isolado_entre_empresas():
    headers_a = criar_empresa("Produto Multi A")
    headers_b = criar_empresa("Produto Multi B")
    p = criar_produto(headers_a, "So Da Empresa A", preco=99, custo=1)
    vender(headers_a, [(p, 1)])

    rep_b = relatorio(headers_b)
    assert produto_no_ranking(rep_b, p["id"]) is None


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
