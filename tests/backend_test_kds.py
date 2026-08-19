#!/usr/bin/env python3
"""
Restaurant OS - KDS Test Suite
Cobre: GET /kds/pendentes, POST /kds/concluir, isolamento multi-tenant,
tokens da TV (gerar/listar/revogar), modo leitura vs toque.
"""

import requests
import random
import string
import os

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

results = {"passed": [], "failed": [], "critical_failures": []}

def log_pass(test_name):
    print(f"PASS: {test_name}")
    results["passed"].append(test_name)

def log_fail(test_name, reason, critical=False):
    print(f"FAIL: {test_name}")
    print(f"   Reason: {reason}")
    results["failed"].append({"test": test_name, "reason": reason})
    if critical:
        results["critical_failures"].append({"test": test_name, "reason": reason})

def random_email():
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"kds.{rand}@teste.com"

def registrar_tenant(nome_empresa):
    email = random_email()
    resp = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome_empresa, "nome": "Dono Teste", "email": email, "senha": "senha_123456"
    })
    assert resp.status_code == 200, f"register falhou: {resp.text}"
    data = resp.json()
    # Desde 2026-08-19 (B2, onboarding guiado) o registro NAO semeia mais
    # sozinho — ver route.js. Esta suite assume a comanda/mesa demo abaixo.
    seed = requests.post(f"{BASE_URL}/empresa/seed-demo", headers={"Authorization": f"Bearer {data['token']}"})
    assert seed.status_code == 200, f"seed-demo falhou: {seed.text}"
    return {"token": data["token"], "empresa": data["empresa"], "usuario": data["usuario"]}

try:
    print("Setup: registrando tenant A e B...")
    a = registrar_tenant("KDS Teste A")
    b = registrar_tenant("KDS Teste B")
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    # Precisa de ao menos um produto para criar pedido/comanda com item.
    def criar_produto(headers):
        resp = requests.post(f"{BASE_URL}/categorias", json={"nome": "Lanches"}, headers=headers)
        cat_id = resp.json()["id"]
        resp = requests.post(f"{BASE_URL}/produtos", json={
            "nome": "X-Burger", "preco": 25.0, "categoria_id": cat_id, "disponivel": True
        }, headers=headers)
        return resp.json()

    produto_a = criar_produto(headers_a)

    print("\n1. GET /kds/pendentes - pedido novo aparece")
    resp = requests.post(f"{BASE_URL}/pedidos", json={
        "itens": [{"produto_id": produto_a["id"], "nome": produto_a["nome"], "preco": produto_a["preco"], "quantidade": 1, "observacao": "sem cebola"}],
        "tipo": "balcao", "pagamento": "pix"
    }, headers=headers_a)
    if resp.status_code == 201:
        pedido = resp.json()
        log_pass("POST /pedidos - cria pedido de teste")
    else:
        log_fail("POST /pedidos", resp.text, critical=True)
        pedido = None

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    if resp.status_code == 200:
        itens = resp.json()["itens"]
        achou = any(i["origem"] == "pedido" and i["id"] == pedido["id"] and i["itens"][0]["observacao"] == "sem cebola" for i in itens)
        if achou:
            log_pass("GET /kds/pendentes - pedido novo aparece com observacao")
        else:
            log_fail("GET /kds/pendentes - pedido novo", f"nao encontrado em {itens}", critical=True)
    else:
        log_fail("GET /kds/pendentes", resp.text, critical=True)

    print("\n2. POST /kds/concluir (pedido) - remove da lista")
    resp = requests.post(f"{BASE_URL}/kds/concluir", json={"origem": "pedido", "id": pedido["id"]}, headers=headers_a)
    if resp.status_code == 200:
        log_pass("POST /kds/concluir - conclui pedido")
    else:
        log_fail("POST /kds/concluir (pedido)", resp.text, critical=True)

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if not any(i["id"] == pedido["id"] for i in itens):
        log_pass("GET /kds/pendentes - pedido concluido some da lista")
    else:
        log_fail("GET /kds/pendentes - pedido concluido", "ainda aparece na lista", critical=True)

    print("\n3. Isolamento multi-tenant")
    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_b)
    itens_b = resp.json()["itens"]
    if not any(i.get("id") == pedido["id"] for i in itens_b):
        log_pass("GET /kds/pendentes - tenant B nunca ve pedido do tenant A")
    else:
        log_fail("Isolamento multi-tenant", "tenant B viu pedido de A", critical=True)

    print("\n4. Item de comanda (mesa)")
    # O seed de registro ja abre uma comanda demo numa mesa (HANDOFF.md §10
    # armadilha 10) - precisa filtrar por status 'livre', nao pegar mesas[0].
    mesas_a = requests.get(f"{BASE_URL}/mesas", headers=headers_a).json()
    mesa_livre = next(m for m in mesas_a if m["status"] == "livre")
    resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", json={"pessoas": 2}, headers=headers_a)
    comanda = resp.json()
    resp = requests.post(f"{BASE_URL}/comandas/{comanda['id']}/itens", json={"produto_id": produto_a["id"], "quantidade": 1}, headers=headers_a)
    item = resp.json()["itens"][-1]

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if any(i["origem"] == "mesa" and i["id"] == item["id"] for i in itens):
        log_pass("GET /kds/pendentes - item de comanda aparece")
    else:
        log_fail("GET /kds/pendentes - item de comanda", f"nao encontrado em {itens}", critical=True)

    resp = requests.post(f"{BASE_URL}/kds/concluir", json={"origem": "mesa", "id": item["id"], "comanda_id": comanda["id"]}, headers=headers_a)
    if resp.status_code == 200:
        log_pass("POST /kds/concluir - conclui item de mesa")
    else:
        log_fail("POST /kds/concluir (mesa)", resp.text, critical=True)

    resp = requests.get(f"{BASE_URL}/kds/pendentes", headers=headers_a)
    itens = resp.json()["itens"]
    if not any(i.get("id") == item["id"] for i in itens):
        log_pass("GET /kds/pendentes - item de mesa concluido some da lista")
    else:
        log_fail("GET /kds/pendentes - item de mesa concluido", "ainda aparece", critical=True)

    print("\n5. Sem autenticacao")
    resp = requests.get(f"{BASE_URL}/kds/pendentes")
    if resp.status_code == 401:
        log_pass("GET /kds/pendentes sem token/tv_token - 401")
    else:
        log_fail("GET /kds/pendentes sem auth", f"esperava 401, veio {resp.status_code}", critical=True)

    print("\n6. Gestao de tokens da TV")
    resp = requests.post(f"{BASE_URL}/kds/tokens", json={"modo": "toque"}, headers=headers_a)
    if resp.status_code == 201 and resp.json()["modo"] == "toque":
        log_pass("POST /kds/tokens - cria token modo toque")
        tv_token = resp.json()["token"]
        tv_token_id = resp.json()["id"]
    else:
        log_fail("POST /kds/tokens", resp.text, critical=True)
        tv_token = None

    resp = requests.get(f"{BASE_URL}/kds/pendentes?tv_token={tv_token}")
    if resp.status_code == 200 and resp.json()["modo"] == "toque":
        log_pass("GET /kds/pendentes?tv_token=... - le sem login, modo correto")
    else:
        log_fail("GET /kds/pendentes com tv_token", resp.text, critical=True)

    # Token modo leitura nao pode concluir
    resp = requests.post(f"{BASE_URL}/kds/tokens", json={"modo": "leitura"}, headers=headers_a)
    tv_token_leitura = resp.json()["token"]
    tv_token_leitura_id = resp.json()["id"]

    resp = requests.get(f"{BASE_URL}/kds/tokens", headers=headers_a)
    if resp.status_code == 200:
        ids_listados = [t["id"] for t in resp.json()]
        if tv_token_id in ids_listados and tv_token_leitura_id in ids_listados:
            log_pass("GET /kds/tokens - lista tokens ativos da empresa")
        else:
            log_fail("GET /kds/tokens - lista tokens ativos", f"esperava {tv_token_id} e {tv_token_leitura_id} em {ids_listados}", critical=True)
    else:
        log_fail("GET /kds/tokens", resp.text, critical=True)

    # O seed de registro ja abre 1 mesa demo - pega outra que ainda esteja livre.
    mesas_a2 = requests.get(f"{BASE_URL}/mesas", headers=headers_a).json()
    mesa_livre2 = next(m for m in mesas_a2 if m["status"] == "livre")
    resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre2['id']}/abrir", json={"pessoas": 1}, headers=headers_a)
    comanda2 = resp.json()
    resp = requests.post(f"{BASE_URL}/comandas/{comanda2['id']}/itens", json={"produto_id": produto_a["id"], "quantidade": 1}, headers=headers_a)
    item2 = resp.json()["itens"][-1]

    resp = requests.post(f"{BASE_URL}/kds/concluir?tv_token={tv_token_leitura}", json={"origem": "mesa", "id": item2["id"], "comanda_id": comanda2["id"]})
    if resp.status_code == 403:
        log_pass("POST /kds/concluir com token modo leitura - 403")
    else:
        log_fail("POST /kds/concluir com token modo leitura", f"esperava 403, veio {resp.status_code}", critical=True)

    resp = requests.post(f"{BASE_URL}/kds/concluir?tv_token={tv_token}", json={"origem": "mesa", "id": item2["id"], "comanda_id": comanda2["id"]})
    if resp.status_code == 200:
        log_pass("POST /kds/concluir com token modo toque - 200")
    else:
        log_fail("POST /kds/concluir com token modo toque", resp.text, critical=True)

    # Revogar e confirmar que para de funcionar
    resp = requests.delete(f"{BASE_URL}/kds/tokens/{tv_token_id}", headers=headers_a)
    resp = requests.get(f"{BASE_URL}/kds/pendentes?tv_token={tv_token}")
    if resp.status_code == 401:
        log_pass("Token revogado - GET /kds/pendentes retorna 401")
    else:
        log_fail("Token revogado ainda funciona", f"status {resp.status_code}", critical=True)

    resp = requests.get(f"{BASE_URL}/kds/tokens", headers=headers_a)
    ids_listados = [t["id"] for t in resp.json()]
    if tv_token_id not in ids_listados and tv_token_leitura_id in ids_listados:
        log_pass("GET /kds/tokens - token revogado nao aparece mais na listagem (filtro server-side)")
    else:
        log_fail("GET /kds/tokens apos revogar", f"esperava sem {tv_token_id} e com {tv_token_leitura_id} em {ids_listados}", critical=True)

    print("\n7. Permissoes - GERENTE nao pode gerenciar tokens da TV")
    novo_gerente = {"nome": "Gerente Teste", "email": random_email(), "senha": "senha_123456", "papel": "GERENTE"}
    resp = requests.post(f"{BASE_URL}/usuarios", json=novo_gerente, headers=headers_a)
    if resp.status_code == 201:
        log_pass("POST /usuarios - cria usuario GERENTE para teste de permissao")
    else:
        log_fail("POST /usuarios (GERENTE)", resp.text, critical=True)

    resp = requests.post(f"{BASE_URL}/auth/login", json={"email": novo_gerente["email"], "senha": novo_gerente["senha"]})
    headers_gerente = {"Authorization": f"Bearer {resp.json()['token']}"}

    resp = requests.get(f"{BASE_URL}/kds/tokens", headers=headers_gerente)
    if resp.status_code == 403:
        log_pass("GET /kds/tokens com GERENTE - 403")
    else:
        log_fail("GET /kds/tokens com GERENTE", f"esperava 403, veio {resp.status_code}", critical=True)

    resp = requests.post(f"{BASE_URL}/kds/tokens", json={"modo": "toque"}, headers=headers_gerente)
    if resp.status_code == 403:
        log_pass("POST /kds/tokens com GERENTE - 403")
    else:
        log_fail("POST /kds/tokens com GERENTE", f"esperava 403, veio {resp.status_code}", critical=True)

    resp = requests.delete(f"{BASE_URL}/kds/tokens/{tv_token_leitura_id}", headers=headers_gerente)
    if resp.status_code == 403:
        log_pass("DELETE /kds/tokens/:id com GERENTE - 403")
    else:
        log_fail("DELETE /kds/tokens/:id com GERENTE", f"esperava 403, veio {resp.status_code}", critical=True)

except Exception as e:
    print(f"\nFATAL ERROR: {str(e)}")
    import traceback
    traceback.print_exc()

print(f"\nPASSED: {len(results['passed'])}  FAILED: {len(results['failed'])}  CRITICAL: {len(results['critical_failures'])}")
if results['failed']:
    for f in results['failed']:
        print(f"  - {f['test']}: {f['reason']}")

# Codigo de saida para o runner (tests/run_all.py) e para CI.
# Sem isto a suite imprime falhas e sai com 0 — um runner que confie no exit
# code reportaria verde para suite quebrada.
import sys as _sys
_sys.exit(1 if results['failed'] else 0)
