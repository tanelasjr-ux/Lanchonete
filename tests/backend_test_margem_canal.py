"""Margem bruta por canal de venda (balcao/mesa/delivery/retirada).

O total consolidado esconde a pergunta que decide contrato de app de entrega:
o delivery esta pagando o que custa? Vender muito e ganhar pouco so aparece
quando se separa por canal.
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


def criar_produto(headers, nome, preco, custo):
    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": nome, "preco": preco, "custo": custo,
    })
    assert r.status_code == 201, r.text
    return r.json()


def criar_pedido_pago(headers, tipo, itens, entrega_taxa=0):
    """Cria um pedido do `tipo` dado e marca como concluido (gera a transacao de receita).

    `preco` vai explicito no item porque o servidor confia no que o cliente
    manda (o front carrega o preco junto com a lista de produtos) — nao
    resolve pelo produto_id no POST /pedidos.
    """
    body = {
        "tipo": tipo, "cliente_nome": "Cliente Teste", "pagamento": "pix",
        "itens": [{"produto_id": p["id"], "preco": p["preco"], "quantidade": q} for p, q in itens],
    }
    if entrega_taxa:
        body["entrega_taxa"] = entrega_taxa
    r = requests.post(f"{BASE_URL}/pedidos", headers=headers, json=body)
    assert r.status_code == 201, r.text
    pedido = r.json()

    r2 = requests.put(f"{BASE_URL}/pedidos/{pedido['id']}", headers=headers, json={"status": "concluido"})
    assert r2.status_code == 200, r2.text
    return pedido


def relatorio(headers, filtro_tipo=None):
    params = {}
    if filtro_tipo:
        params["tipo"] = filtro_tipo
    r = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def canal(rep, chave):
    return next((c for c in rep["margem_por_canal"]["canais"] if c["canal"] == chave), None)


def test_relatorio_devolve_margem_por_canal():
    headers = criar_empresa("Canal Existe")
    rep = relatorio(headers)
    assert "margem_por_canal" in rep
    assert "canais" in rep["margem_por_canal"]


def test_canais_diferentes_ficam_em_buckets_separados():
    """Um pedido de balcao e um de delivery aparecem em linhas distintas, sem misturar."""
    headers = criar_empresa("Canais Separados")
    p = criar_produto(headers, "Prato Canal", preco=50, custo=20)

    criar_pedido_pago(headers, "balcao", [(p, 2)])
    criar_pedido_pago(headers, "delivery", [(p, 1)], entrega_taxa=8)

    rep = relatorio(headers)
    balcao = canal(rep, "balcao")
    delivery = canal(rep, "delivery")

    assert balcao is not None and delivery is not None
    assert balcao["receita_base"] == 100, balcao   # 2x R$50
    assert delivery["receita_base"] == 50, delivery  # 1x R$50, taxa fora


def test_taxa_de_entrega_fica_fora_da_receita_de_mercadoria():
    """A taxa de entrega aparece em campo proprio, nao inflando receita_base nem custo.

    Taxa de entrega e receita de servico. Misturar com receita de mercadoria
    distorceria a margem do canal delivery para melhor do que realmente e.
    """
    headers = criar_empresa("Taxa Fora")
    p = criar_produto(headers, "Prato Delivery", preco=40, custo=15)
    criar_pedido_pago(headers, "delivery", [(p, 1)], entrega_taxa=12)

    rep = relatorio(headers)
    delivery = canal(rep, "delivery")
    assert delivery["receita_base"] == 40, "taxa de entrega nao pode entrar na receita de mercadoria"
    assert delivery["taxa_entrega"] == 12


def test_margem_percent_calculada_corretamente():
    """Margem = (receita_com_custo - custo_total) / receita_com_custo * 100."""
    headers = criar_empresa("Margem Calculada")
    # Produto que custa 40% do preco -> margem esperada de 60%.
    p = criar_produto(headers, "Margem 60", preco=100, custo=40)
    criar_pedido_pago(headers, "balcao", [(p, 3)])

    rep = relatorio(headers)
    balcao = canal(rep, "balcao")
    assert balcao["custo_total"] == 120, balcao  # 3 x 40
    assert balcao["margem_percent"] == 60.0, balcao


def test_produto_sem_custo_cadastrado_da_margem_null_nao_zero():
    """Sem custo cadastrado, margem e `null` — nao e 0, que mentiria "sem lucro"."""
    headers = criar_empresa("Sem Custo Canal")
    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json={"nome": "Sem Custo", "preco": 30})
    assert r.status_code == 201, r.text
    p = r.json()
    criar_pedido_pago(headers, "retirada", [(p, 1)])

    rep = relatorio(headers)
    retirada = canal(rep, "retirada")
    assert retirada["margem_percent"] is None
    assert retirada["receita_base"] == 30, "receita conta mesmo sem custo"


def test_ticket_medio_por_canal():
    """Ticket medio do canal e a receita dividida pelo numero de pedidos DAQUELE canal."""
    headers = criar_empresa("Ticket Canal")
    p = criar_produto(headers, "Item Ticket", preco=25, custo=10)
    criar_pedido_pago(headers, "mesa", [(p, 1)])
    criar_pedido_pago(headers, "mesa", [(p, 3)])

    rep = relatorio(headers)
    mesa = canal(rep, "mesa")
    assert mesa["pedidos"] == 2
    assert mesa["receita_base"] == 100  # 25 + 75
    assert mesa["ticket_medio"] == 50, mesa  # 100 / 2


def test_canais_isolados_entre_empresas():
    """Pedido de uma empresa nao aparece no canal de outra."""
    headers_a = criar_empresa("Canal Multi A")
    headers_b = criar_empresa("Canal Multi B")
    p = criar_produto(headers_a, "Produto A", preco=99, custo=10)
    criar_pedido_pago(headers_a, "balcao", [(p, 1)])

    rep_b = relatorio(headers_b)
    balcao_b = canal(rep_b, "balcao")
    if balcao_b is not None:
        assert balcao_b["receita_base"] != 99


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
