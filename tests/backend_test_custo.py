#!/usr/bin/env python3
"""
Restaurant OS - Suite de integracao de Custo e CMV
Cobre: gravacao de custo/receita nas transacoes (pedido direto e comanda
com split), estorno sem custo, exposicao do bloco cmv no dashboard e no
relatorio financeiro, e isolamento multi-tenant.
"""

import os
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def nova_empresa(nome):
    """Cria empresa + usuario e devolve (headers, empresa_id)."""
    email = f"{nome.lower()}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Dono Teste", "email": email, "senha": "senha123",
    })
    r.raise_for_status()
    dados = r.json()
    headers = {"Authorization": f"Bearer {dados['token']}"}
    # Desde 2026-08-19 (B2, onboarding guiado) o registro NAO semeia mais
    # sozinho — ver route.js. Os testes desta suite ja contavam com a massa
    # demo (mesas, "ruido" de vendas filtrado por pedido_id/comanda_id).
    requests.post(f"{BASE_URL}/empresa/seed-demo", headers=headers)
    return headers, dados["empresa"]["id"]


def novo_produto(headers, nome, preco, custo):
    cat = requests.post(f"{BASE_URL}/categorias",
                        json={"nome": "Geral", "ordem": 1}, headers=headers).json()
    return requests.post(f"{BASE_URL}/produtos", json={
        "categoria_id": cat["id"], "nome": nome, "preco": preco,
        "custo": custo, "disponivel": True,
    }, headers=headers).json()


def concluir_pedido(headers, produto, quantidade=1):
    """Cria e conclui um pedido, devolvendo o pedido concluido."""
    pedido = requests.post(f"{BASE_URL}/pedidos", json={
        "tipo": "balcao", "pagamento": "dinheiro",
        "itens": [{"produto_id": produto["id"], "nome": produto["nome"],
                   "preco": produto["preco"], "quantidade": quantidade}],
    }, headers=headers).json()
    return requests.put(f"{BASE_URL}/pedidos/{pedido['id']}",
                        json={"status": "concluido"}, headers=headers).json()


def transacoes(headers):
    return requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()


def test_pedido_concluido_grava_custo():
    """Pedido de produto com custo grava os tres campos."""
    headers, _ = nova_empresa("CustoBasico")
    p = novo_produto(headers, "Hamburguer", 20.0, 8.0)
    pedido = concluir_pedido(headers, p, quantidade=2)

    # nova_empresa() semeia dados demo (pedidos/transacoes aleatorios via
    # seedEmpresa) — filtrar so por categoria "Vendas" pega ruido da massa
    # demo. Precisa amarrar pelo pedido_id, igual backend_test_caixa.py faz.
    vendas = [t for t in transacoes(headers)
              if t["tipo"] == "receita" and t.get("pedido_id") == pedido["id"]]
    assert len(vendas) == 1, f"esperava 1 venda, veio {len(vendas)}"
    t = vendas[0]
    assert float(t["custo_total"]) == 16.0, t["custo_total"]
    assert float(t["receita_com_custo"]) == 40.0, t["receita_com_custo"]
    assert float(t["receita_base"]) == 40.0, t["receita_base"]


def test_produto_sem_custo_fica_fora():
    """Produto com custo nulo entra so em receita_base."""
    headers, _ = nova_empresa("SemCusto")
    p = novo_produto(headers, "Agua", 5.0, None)
    pedido = concluir_pedido(headers, p)

    t = [x for x in transacoes(headers)
         if x["tipo"] == "receita" and x.get("pedido_id") == pedido["id"]][0]
    assert float(t["custo_total"]) == 0.0
    assert float(t["receita_com_custo"]) == 0.0
    assert float(t["receita_base"]) == 5.0


def test_custo_zero_entra_no_calculo():
    """Custo zero e coberto — diferente de custo nao cadastrado."""
    headers, _ = nova_empresa("CustoZero")
    p = novo_produto(headers, "Brinde", 10.0, 0)
    pedido = concluir_pedido(headers, p)

    t = [x for x in transacoes(headers)
         if x["tipo"] == "receita" and x.get("pedido_id") == pedido["id"]][0]
    assert float(t["custo_total"]) == 0.0
    assert float(t["receita_com_custo"]) == 10.0, "custo 0 deve ser coberto"


def test_comanda_dividida_rateia_o_custo():
    """Comanda paga em dois metodos: a soma dos custos bate com o total."""
    headers, _ = nova_empresa("Dividida")
    p = novo_produto(headers, "Pizza", 100.0, 40.0)

    r = requests.get(f"{BASE_URL}/mesas", headers=headers)
    r.raise_for_status()
    mesa_livre = next(m for m in r.json() if m["status"] == "livre")
    r = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", headers=headers, json={"pessoas": 2})
    r.raise_for_status()
    comanda = r.json()
    requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", json={
        "produto_id": p["id"], "nome": p["nome"], "preco": p["preco"], "quantidade": 1,
    }, headers=headers)
    # zera a taxa de servico para o total ser exatamente o subtotal
    requests.put(f"{BASE_URL}/comandas/{comanda['id']}",
                 json={"taxa_servico_percent": 0}, headers=headers)
    for metodo, valor in [("dinheiro", 60.0), ("cartao", 40.0)]:
        requests.post(f"{BASE_URL}/comandas/{comanda['id']}/pagamentos",
                      json={"metodo": metodo, "valor": valor}, headers=headers)
    requests.post(f"{BASE_URL}/comandas/{comanda['id']}/fechar", json={}, headers=headers)

    # Igual ao caso do pedido direto: a massa demo criada por nova_empresa()
    # tambem gera transacoes "Vendas", entao filtra pelo comanda_id.
    vendas = [t for t in transacoes(headers)
              if t["tipo"] == "receita" and t.get("comanda_id") == comanda["id"]]
    assert len(vendas) == 2, f"esperava 2 transacoes, veio {len(vendas)}"
    assert abs(sum(float(t["custo_total"]) for t in vendas) - 40.0) < 0.02
    assert abs(sum(float(t["receita_base"]) for t in vendas) - 100.0) < 0.02


def test_estorno_nao_devolve_custo():
    """Estorno e despesa e nao carrega custo."""
    headers, _ = nova_empresa("Estorno")
    p = novo_produto(headers, "Prato", 50.0, 20.0)
    pedido = concluir_pedido(headers, p)

    requests.post(f"{BASE_URL}/pedidos/{pedido['id']}/estorno",
                  json={"valor": 50.0, "motivo": "cliente desistiu"}, headers=headers)

    estornos = [t for t in transacoes(headers)
                if t["categoria"] == "Estorno" and t.get("pedido_id") == pedido["id"]]
    assert len(estornos) == 1
    # /pedidos/:id/estorno nao grava custo_total/receita_com_custo — o campo
    # fica ausente na transacao, nao zerado. "Nao carrega custo" quer dizer
    # isso: sem valor de custo nenhum, e nao um 0.0 explicito no schema.
    assert float(estornos[0].get("custo_total") or 0) == 0.0
    assert float(estornos[0].get("receita_com_custo") or 0) == 0.0


def test_dashboard_expoe_cmv():
    """Dashboard devolve o bloco cmv com os indicadores calculados."""
    headers, _ = nova_empresa("DashCmv")
    com_custo = novo_produto(headers, "Com custo", 20.0, 8.0)
    concluir_pedido(headers, com_custo)

    cmv = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers).json()["cmv"]
    assert float(cmv["custo_total"]) == 8.0
    assert float(cmv["receita_com_custo"]) == 20.0
    assert abs(float(cmv["cmv_percent"]) - 40.0) < 0.1
    assert float(cmv["lucro_bruto"]) == 12.0


def test_cmv_nulo_quando_nada_tem_custo():
    """Sem nenhum custo cadastrado, os indicadores sao null e nao zero."""
    headers, _ = nova_empresa("CmvNulo")
    p = novo_produto(headers, "Sem custo", 30.0, None)
    concluir_pedido(headers, p)

    cmv = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers).json()["cmv"]
    assert cmv["cmv_percent"] is None, "deve ser null, nao 0"
    assert cmv["lucro_bruto"] is None, "deve ser null, nao 0"
    assert float(cmv["cobertura_percent"]) == 0.0, "ha base, cobertura e zero real"


def test_relatorio_expoe_cmv():
    """Relatorio financeiro devolve o bloco cmv no periodo."""
    headers, _ = nova_empresa("RelCmv")
    p = novo_produto(headers, "Item", 40.0, 10.0)
    concluir_pedido(headers, p)

    cmv = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers).json()["cmv"]
    assert float(cmv["custo_total"]) == 10.0
    assert abs(float(cmv["cmv_percent"]) - 25.0) < 0.1


def test_isolamento_multi_tenant():
    """Empresa A nao ve o custo da empresa B."""
    ha, _ = nova_empresa("TenantA")
    hb, _ = nova_empresa("TenantB")
    concluir_pedido(ha, novo_produto(ha, "ProdutoA", 100.0, 50.0))
    concluir_pedido(hb, novo_produto(hb, "ProdutoB", 10.0, 1.0))

    a = requests.get(f"{BASE_URL}/dashboard/metrics", headers=ha).json()["cmv"]
    b = requests.get(f"{BASE_URL}/dashboard/metrics", headers=hb).json()["cmv"]
    assert float(a["custo_total"]) == 50.0
    assert float(b["custo_total"]) == 1.0


if __name__ == "__main__":
    testes = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    falhas = 0
    for t in testes:
        try:
            t()
            print(f"PASS: {t.__name__}")
        except Exception as e:
            falhas += 1
            print(f"FAIL: {t.__name__}\n   {e}")
    print(f"\n{len(testes) - falhas}/{len(testes)} testes passaram")
    raise SystemExit(1 if falhas else 0)
