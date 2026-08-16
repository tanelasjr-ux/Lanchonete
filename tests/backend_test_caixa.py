#!/usr/bin/env python3
"""
Restaurant OS - Suite de testes do Caixa
Cobre: abertura, fechamento, conferencia, sangria, suprimento, estorno,
forma de pagamento na transacao (pedido direto e comanda com split) e
isolamento multi-tenant.

Endpoints exercitados (Tasks 7, 8 e 9):
  GET  /caixa/atual
  POST /caixa/abrir
  GET  /caixa/historico
  POST /caixa/fechar
  POST /caixa/movimento
  POST /pedidos/:id/estorno
"""

import os
import random
import string
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

results = {"passed": [], "failed": []}


def log_pass(nome):
    print(f"PASS: {nome}")
    results["passed"].append(nome)


def log_fail(nome, motivo):
    print(f"FAIL: {nome}")
    print(f"   Motivo: {motivo}")
    results["failed"].append({"teste": nome, "motivo": motivo})


def rand(prefixo):
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefixo}.{s}@teste.com"


def criar_empresa():
    """Cria empresa + usuario OWNER e devolve (headers, empresa_id)."""
    email = rand("caixa")
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": f"Caixa Teste {email[:12]}",
        "nome": "Dono Teste",
        "email": email,
        "senha": "senha123456",
    })
    r.raise_for_status()
    dados = r.json()
    token = dados["token"]
    return {"Authorization": f"Bearer {token}"}, dados.get("empresa", {}).get("id")


def criar_produto(headers, preco, nome="Item Teste"):
    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json={
        "nome": nome, "preco": preco, "disponivel": True,
    })
    r.raise_for_status()
    return r.json()


def criar_pedido(headers, valor, pagamento="dinheiro"):
    """Cria produto + pedido balcao (status inicial 'recebido'). Devolve o pedido."""
    produto = criar_produto(headers, valor)
    r = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "balcao",
        "pagamento": pagamento,
        "itens": [{"produto_id": produto["id"], "nome": produto["nome"],
                   "preco": valor, "quantidade": 1}],
    })
    r.raise_for_status()
    return r.json()


def concluir_pedido(headers, pedido_id):
    """PUT /pedidos/:id com status concluido - gera a transacao de receita."""
    r = requests.put(f"{BASE_URL}/pedidos/{pedido_id}", headers=headers,
                      json={"status": "concluido"})
    r.raise_for_status()
    return r.json()


def criar_pedido_concluido(headers, valor, pagamento="dinheiro"):
    pedido = criar_pedido(headers, valor, pagamento)
    return concluir_pedido(headers, pedido["id"])


def transacoes_de(headers, **filtros):
    r = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers)
    r.raise_for_status()
    todas = r.json()
    out = todas
    for k, v in filtros.items():
        out = [t for t in out if t.get(k) == v]
    return out


def main():
    headers, _ = criar_empresa()

    # ===================================================================
    # 1. Estado inicial: sem caixa aberto
    # ===================================================================
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r.json().get("caixa") is None:
        log_pass("caixa/atual devolve null quando nao ha caixa aberto")
    else:
        log_fail("caixa/atual devolve null quando nao ha caixa aberto", r.text)

    # ===================================================================
    # 2. Abertura
    # ===================================================================
    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 100})
    if r.status_code == 200 and r.json()["caixa"]["valor_abertura"] == 100 and r.json()["caixa"]["status"] == "aberto":
        log_pass("abrir caixa com fundo de troco")
    else:
        log_fail("abrir caixa com fundo de troco", r.text)

    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 50})
    if r.status_code == 409:
        log_pass("abrir segundo caixa enquanto o primeiro esta aberto retorna 409")
    else:
        log_fail("abrir segundo caixa enquanto o primeiro esta aberto retorna 409", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": -5})
    if r.status_code == 400:
        log_pass("valor_abertura negativo retorna 400")
    else:
        log_fail("valor_abertura negativo retorna 400", f"status {r.status_code}")

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r.json()["resumo"]["valor_esperado"] == 100:
        log_pass("caixa/atual com caixa aberto reflete o valor de abertura")
    else:
        log_fail("caixa/atual com caixa aberto reflete o valor de abertura", r.text)

    # ===================================================================
    # 3. Venda em dinheiro entra na gaveta / venda em pix nao entra
    # ===================================================================
    pedido_dinheiro = criar_pedido_concluido(headers, 50, "dinheiro")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    esperado = r.json()["resumo"]["valor_esperado"]
    if esperado == 150:
        log_pass("venda em dinheiro entra no esperado (100 + 50)")
    else:
        log_fail("venda em dinheiro entra no esperado (100 + 50)", f"esperado 150, veio {esperado}")

    criar_pedido_concluido(headers, 80, "pix")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    resumo = r.json()["resumo"]
    if resumo["valor_esperado"] == 150:
        log_pass("venda em pix nao altera o esperado da gaveta")
    else:
        log_fail("venda em pix nao altera o esperado da gaveta", f"veio {resumo['valor_esperado']}")
    if resumo["por_forma_pagamento"].get("pix") == 80:
        log_pass("venda em pix aparece no resumo por forma de pagamento")
    else:
        log_fail("venda em pix aparece no resumo por forma de pagamento", str(resumo))

    # ===================================================================
    # 4. Sangria e suprimento
    # ===================================================================
    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                       json={"tipo": "sangria", "valor": 30, "motivo": "deposito"})
    if r.status_code == 200:
        log_pass("registrar sangria")
    else:
        log_fail("registrar sangria", r.text)

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.json()["resumo"]["valor_esperado"] == 120:
        log_pass("sangria reduz o esperado (150 - 30)")
    else:
        log_fail("sangria reduz o esperado (150 - 30)", str(r.json()["resumo"]))

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                       json={"tipo": "sangria", "valor": 9999, "motivo": "demais"})
    if r.status_code == 400:
        log_pass("sangria maior que o disponivel retorna 400")
    else:
        log_fail("sangria maior que o disponivel retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                       json={"tipo": "suprimento", "valor": 10, "motivo": "troco"})
    r2 = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r2.json()["resumo"]["valor_esperado"] == 130:
        log_pass("suprimento aumenta o esperado (120 + 10)")
    else:
        log_fail("suprimento aumenta o esperado (120 + 10)", r.text)

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                       json={"tipo": "invalido", "valor": 10})
    if r.status_code == 400:
        log_pass("tipo de movimento invalido retorna 400")
    else:
        log_fail("tipo de movimento invalido retorna 400", f"status {r.status_code}")

    # ===================================================================
    # 5. Estorno
    # ===================================================================
    r = requests.post(f"{BASE_URL}/pedidos/{pedido_dinheiro['id']}/estorno", headers=headers,
                       json={"valor": 15, "motivo": "cliente desistiu"})
    if r.status_code == 200:
        log_pass("estornar parcialmente um pedido concluido")
    else:
        log_fail("estornar parcialmente um pedido concluido", r.text)

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.json()["resumo"]["valor_esperado"] == 115:
        log_pass("estorno em dinheiro reduz o esperado da gaveta (130 - 15)")
    else:
        log_fail("estorno em dinheiro reduz o esperado da gaveta (130 - 15)", str(r.json()["resumo"]))

    r = requests.post(f"{BASE_URL}/pedidos/{pedido_dinheiro['id']}/estorno", headers=headers,
                       json={"valor": 100, "motivo": "acima do total"})
    if r.status_code == 400:
        log_pass("estorno acumulado acima do total retorna 400")
    else:
        log_fail("estorno acumulado acima do total retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/pedidos/{pedido_dinheiro['id']}/estorno", headers=headers,
                       json={"valor": 5})
    if r.status_code == 400:
        log_pass("estorno sem motivo retorna 400")
    else:
        log_fail("estorno sem motivo retorna 400", f"status {r.status_code}")

    pedido_pendente = criar_pedido(headers, 30, "dinheiro")  # status 'recebido', nao concluido
    r = requests.post(f"{BASE_URL}/pedidos/{pedido_pendente['id']}/estorno", headers=headers,
                       json={"valor": 5, "motivo": "tentativa invalida"})
    if r.status_code == 400:
        log_pass("estornar pedido nao concluido retorna 400")
    else:
        log_fail("estornar pedido nao concluido retorna 400", f"status {r.status_code}")

    # ===================================================================
    # 6. Fechamento do primeiro caixa
    # ===================================================================
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    esperado_final = r.json()["resumo"]["valor_esperado"]  # 115

    r = requests.post(f"{BASE_URL}/caixa/fechar", headers=headers,
                       json={"valor_contado": esperado_final - 5})
    if r.status_code == 400:
        log_pass("fechar com diferenca sem observacao retorna 400")
    else:
        log_fail("fechar com diferenca sem observacao retorna 400", f"status {r.status_code}")

    r = requests.post(f"{BASE_URL}/caixa/fechar", headers=headers,
                       json={"valor_contado": esperado_final - 5, "observacoes": "faltou troco no inicio do dia"})
    if r.status_code == 200 and r.json()["caixa"]["diferenca"] == -5:
        log_pass("fechar com diferenca e observacao registra a diferenca (-5)")
    else:
        log_fail("fechar com diferenca e observacao registra a diferenca (-5)", r.text)

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r.json().get("caixa") is None:
        log_pass("caixa/atual volta a null depois do fechamento")
    else:
        log_fail("caixa/atual volta a null depois do fechamento", r.text)

    r = requests.post(f"{BASE_URL}/caixa/movimento", headers=headers,
                       json={"tipo": "sangria", "valor": 10})
    if r.status_code == 409:
        log_pass("movimento sem caixa aberto retorna 409")
    else:
        log_fail("movimento sem caixa aberto retorna 409", f"status {r.status_code}")

    r = requests.get(f"{BASE_URL}/caixa/historico", headers=headers)
    if r.status_code == 200 and len(r.json()["caixas"]) == 1 and r.json()["caixas"][0]["diferenca"] == -5:
        log_pass("historico lista o caixa fechado com a diferenca correta")
    else:
        log_fail("historico lista o caixa fechado com a diferenca correta", r.text)

    # ===================================================================
    # 7. Venda sem caixa aberto
    # ===================================================================
    pedido_sem_caixa = criar_pedido_concluido(headers, 25, "dinheiro")
    if pedido_sem_caixa.get("id"):
        log_pass("venda com caixa fechado acontece normalmente")
    else:
        log_fail("venda com caixa fechado acontece normalmente", str(pedido_sem_caixa))

    transacao_sem_caixa = transacoes_de(headers, pedido_id=pedido_sem_caixa["id"], tipo="receita")
    if transacao_sem_caixa and transacao_sem_caixa[0].get("caixa_id") is None:
        log_pass("venda sem caixa aberto grava transacao com caixa_id nulo")
    else:
        log_fail("venda sem caixa aberto grava transacao com caixa_id nulo", str(transacao_sem_caixa))

    # ===================================================================
    # 8. Segundo caixa: comanda com split de pagamento (2 metodos -> 2 transacoes)
    # ===================================================================
    r = requests.post(f"{BASE_URL}/caixa/abrir", headers=headers, json={"valor_abertura": 0})
    if r.status_code == 200:
        log_pass("abrir segundo caixa apos o primeiro estar fechado")
    else:
        log_fail("abrir segundo caixa apos o primeiro estar fechado", r.text)

    mesas = requests.get(f"{BASE_URL}/mesas", headers=headers).json()
    mesa_livre = next(m for m in mesas if m["status"] == "livre")
    comanda = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", headers=headers,
                             json={"pessoas": 2}).json()
    # zera a taxa de servico para que o total bata exatamente com a soma dos pagamentos
    requests.put(f"{BASE_URL}/comandas/{comanda['id']}", headers=headers,
                 json={"taxa_servico_percent": 0})
    produto_comanda = criar_produto(headers, 50, "Prato Teste")
    requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", headers=headers,
                  json={"produto_id": produto_comanda["id"], "quantidade": 1})

    p1 = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/pagamentos", headers=headers,
                        json={"metodo": "dinheiro", "valor": 30})
    p2 = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/pagamentos", headers=headers,
                        json={"metodo": "cartao_credito", "valor": 20})
    if p1.status_code == 201 and p2.status_code == 201:
        log_pass("registrar 2 pagamentos (dinheiro + cartao) na comanda")
    else:
        log_fail("registrar 2 pagamentos (dinheiro + cartao) na comanda", f"{p1.text} | {p2.text}")

    fech = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/fechar", headers=headers, json={})
    if fech.status_code == 200:
        log_pass("fechar comanda com pagamento totalmente quitado (2 metodos)")
    else:
        log_fail("fechar comanda com pagamento totalmente quitado (2 metodos)", fech.text)

    transacoes_comanda = transacoes_de(headers, comanda_id=comanda["id"])
    if len(transacoes_comanda) == 2:
        log_pass("comanda com 2 formas de pagamento gera 2 transacoes")
    else:
        log_fail("comanda com 2 formas de pagamento gera 2 transacoes", f"veio {len(transacoes_comanda)}: {transacoes_comanda}")

    pares = sorted((t.get("forma_pagamento"), t.get("valor")) for t in transacoes_comanda)
    esperado_pares = sorted([("dinheiro", 30), ("cartao_credito", 20)])
    if pares == esperado_pares:
        log_pass("transacoes da comanda tem forma de pagamento e valor corretos por metodo")
    else:
        log_fail("transacoes da comanda tem forma de pagamento e valor corretos por metodo", f"veio {pares}")

    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    if r.status_code == 200 and r.json()["resumo"]["valor_esperado"] == 30:
        log_pass("comanda: so a parcela em dinheiro entra no esperado da gaveta (cartao fica de fora)")
    else:
        log_fail("comanda: so a parcela em dinheiro entra no esperado da gaveta (cartao fica de fora)", r.text)

    # ===================================================================
    # 9. Fechamento com valor exato
    # ===================================================================
    criar_pedido_concluido(headers, 20, "dinheiro")
    r = requests.get(f"{BASE_URL}/caixa/atual", headers=headers)
    esperado2 = r.json()["resumo"]["valor_esperado"]
    if esperado2 == 50:
        log_pass("venda em dinheiro soma ao esperado do segundo caixa (30 + 20)")
    else:
        log_fail("venda em dinheiro soma ao esperado do segundo caixa (30 + 20)", f"veio {esperado2}")

    r = requests.post(f"{BASE_URL}/caixa/fechar", headers=headers,
                       json={"valor_contado": esperado2})
    if r.status_code == 200 and r.json()["caixa"]["diferenca"] == 0:
        log_pass("fechar com valor exato registra diferenca zero")
    else:
        log_fail("fechar com valor exato registra diferenca zero", r.text)

    r = requests.get(f"{BASE_URL}/caixa/historico", headers=headers)
    if r.status_code == 200 and len(r.json()["caixas"]) == 2:
        log_pass("historico lista os dois caixas fechados")
    else:
        log_fail("historico lista os dois caixas fechados", r.text)

    # ===================================================================
    # 10. Isolamento multi-tenant
    # ===================================================================
    headers_b, _ = criar_empresa()
    r = requests.get(f"{BASE_URL}/caixa/historico", headers=headers_b)
    if r.status_code == 200 and len(r.json()["caixas"]) == 0:
        log_pass("empresa B nao ve caixas da empresa A")
    else:
        log_fail("empresa B nao ve caixas da empresa A", r.text)

    r = requests.post(f"{BASE_URL}/pedidos/{pedido_dinheiro['id']}/estorno", headers=headers_b,
                       json={"valor": 5, "motivo": "tentativa cross-tenant"})
    if r.status_code == 404:
        log_pass("estornar pedido de outra empresa retorna 404")
    else:
        log_fail("estornar pedido de outra empresa retorna 404", f"status {r.status_code}")

    print(f"\n{len(results['passed'])} passaram, {len(results['failed'])} falharam")
    if results["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"\nFATAL ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        print(f"\n{len(results['passed'])} passaram, {len(results['failed'])} falharam (execucao interrompida)")
        raise SystemExit(1)
