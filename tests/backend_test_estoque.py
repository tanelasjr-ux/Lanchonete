#!/usr/bin/env python3
"""
Restaurant OS - Stock (Estoque) Test Suite
Tests: stock deduction on pedido/comanda, validation, multi-tenant isolation.

Endpoints tested:
- POST /auth/register (setup)
- POST /produtos (create with stock)
- GET /produtos/:id (read)
- PUT /produtos/:id (update stock)
- POST /pedidos (create order)
- PUT /pedidos/:id (conclude order → triggers stock deduction)
"""

import os
import sys
import requests
import random
import string
from datetime import datetime

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")
results = {"passed": [], "failed": [], "critical_failures": []}

def log_pass(nome):
    print(f"✅ PASS: {nome}")
    results["passed"].append(nome)

def log_fail(nome, motivo, critical=False):
    print(f"❌ FAIL: {nome}")
    print(f"   Motivo: {motivo}")
    results["failed"].append({"teste": nome, "motivo": motivo})
    if critical:
        results["critical_failures"].append({"teste": nome, "motivo": motivo})

def random_email():
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"estoque.{rand}@teste.com"

def criar_empresa(nome="Estoque Teste"):
    """Create empresa + OWNER user, return (headers, empresa_id)."""
    email = random_email()
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": f"{nome} {email[:12]}",
        "nome": "Teste User",
        "email": email,
        "senha": "senha123456",
    })
    if r.status_code != 200:
        raise Exception(f"Failed to create empresa: {r.text}")
    dados = r.json()
    token = dados.get("token")
    empresa_id = dados.get("empresa", {}).get("id")
    if not token or not empresa_id:
        raise Exception(f"Invalid response from register: {dados}")
    return {"Authorization": f"Bearer {token}"}, empresa_id

def criar_produto(headers, nome, preco, estoque_habilitado=False, estoque_quantidade=None, estoque_minimo=0):
    """Create product with optional stock tracking."""
    payload = {
        "nome": nome,
        "preco": preco,
        "disponivel": True,
        "estoque_habilitado": estoque_habilitado,
    }
    if estoque_quantidade is not None:
        payload["estoque_quantidade"] = estoque_quantidade
    payload["estoque_minimo"] = estoque_minimo

    r = requests.post(f"{BASE_URL}/produtos", headers=headers, json=payload)
    if r.status_code not in [200, 201]:
        raise Exception(f"Failed to create product: {r.status_code} {r.text}")
    return r.json()

def criar_pedido(headers, produto_id, quantidade, preco):
    """Create pedido with one item."""
    r = requests.post(f"{BASE_URL}/pedidos", headers=headers, json={
        "tipo": "balcao",
        "pagamento": "dinheiro",
        "itens": [{
            "produto_id": produto_id,
            "nome": "Test Item",
            "preco": preco,
            "quantidade": quantidade
        }],
    })
    if r.status_code not in [200, 201]:
        raise Exception(f"Failed to create pedido: {r.status_code} {r.text}")
    return r.json()

def obter_produto(headers, produto_id):
    """Get a single product by ID."""
    r = requests.get(f"{BASE_URL}/produtos/{produto_id}", headers=headers)
    if r.status_code != 200:
        raise Exception(f"Failed to get product: {r.status_code} {r.text}")
    return r.json()

def listar_produtos(headers):
    """List all products for current empresa."""
    r = requests.get(f"{BASE_URL}/produtos", headers=headers)
    if r.status_code != 200:
        raise Exception(f"Failed to list products: {r.status_code} {r.text}")
    return r.json()

def concludir_pedido(headers, pedido_id):
    """Conclude pedido (status = concluido) → triggers stock deduction."""
    r = requests.put(f"{BASE_URL}/pedidos/{pedido_id}", headers=headers, json={"status": "concluido"})
    if r.status_code != 200:
        raise Exception(f"Failed to conclude pedido: {r.status_code} {r.text}")
    return r.json()

def print_section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")

def main():
    try:
        print_section("ESTOQUE TEST SUITE")

        # ===== Test Setup =====
        print("Setup: Creating test empresa and products...")
        headers_a, empresa_a = criar_empresa("Estoque Teste A")
        headers_b, empresa_b = criar_empresa("Estoque Teste B")
        print(f"  Empresa A: {empresa_a}")
        print(f"  Empresa B: {empresa_b}")

        # ===== Test 1: Create product with stock tracking enabled =====
        print("\n[TEST 1] Create product with stock enabled")
        try:
            prod1 = criar_produto(headers_a, "Cerveja Premium", 25.00,
                                 estoque_habilitado=True, estoque_quantidade=100, estoque_minimo=10)
            if prod1.get("estoque_habilitado") and prod1.get("estoque_quantidade") == 100:
                log_pass("Create product with stock enabled (qty=100, min=10)")
            else:
                log_fail("Create product with stock enabled",
                        f"Expected estoque_habilitado=true, qty=100; got {prod1}")
        except Exception as e:
            log_fail("Create product with stock enabled", str(e), critical=True)

        # ===== Test 2: Stock deduction on pedido conclusion =====
        print("\n[TEST 2] Stock deduction on pedido conclusion")
        try:
            pedido1 = criar_pedido(headers_a, prod1["id"], 2, 25.00)
            concludir_pedido(headers_a, pedido1["id"])
            prod1_updated = obter_produto(headers_a, prod1["id"])
            if prod1_updated.get("estoque_quantidade") == 98:
                log_pass("Stock deducts on pedido conclusion (100 - 2 = 98)")
            else:
                log_fail("Stock deducts on pedido conclusion",
                        f"Expected qty=98, got {prod1_updated.get('estoque_quantidade')}")
        except Exception as e:
            log_fail("Stock deducts on pedido conclusion", str(e), critical=True)

        # ===== Test 3: Stock doesn't go negative (hard block) =====
        print("\n[TEST 3] Stock hard block (prevent negative)")
        try:
            prod2 = criar_produto(headers_a, "Vinho Tinto", 45.00,
                                 estoque_habilitado=True, estoque_quantidade=1, estoque_minimo=0)
            pedido2 = criar_pedido(headers_a, prod2["id"], 5, 45.00)
            try:
                concludir_pedido(headers_a, pedido2["id"])
                # After attempt, stock should be at 1 or error
                prod2_updated = obter_produto(headers_a, prod2["id"])
                qty = prod2_updated.get("estoque_quantidade", 1)
                if qty >= 0:
                    log_pass(f"Stock hard block: quantity didn't go negative (final qty={qty})")
                else:
                    log_fail("Stock hard block", f"Quantity went negative: {qty}")
            except Exception as pedido_err:
                # If the API correctly rejects the pedido, that's also a pass
                log_pass("Stock hard block: pedido rejected due to insufficient stock")
        except Exception as e:
            log_fail("Stock hard block", str(e))

        # ===== Test 4: Product without stock tracking - no deduction =====
        print("\n[TEST 4] No stock deduction when tracking disabled")
        try:
            prod3 = criar_produto(headers_a, "Agua 1.5L", 5.00,
                                 estoque_habilitado=True, estoque_quantidade=500, estoque_minimo=50)
            # Disable tracking
            r = requests.put(f"{BASE_URL}/produtos/{prod3['id']}", headers=headers_a,
                           json={"estoque_habilitado": False})
            if r.status_code != 200:
                raise Exception(f"Failed to disable tracking: {r.status_code}")

            pedido3 = criar_pedido(headers_a, prod3["id"], 10, 5.00)
            concludir_pedido(headers_a, pedido3["id"])
            prod3_updated = obter_produto(headers_a, prod3["id"])
            qty = prod3_updated.get("estoque_quantidade")
            if qty == 500:
                log_pass("Stock not deducted when estoque_habilitado=false (qty stayed at 500)")
            else:
                log_fail("Stock not deducted when tracking disabled",
                        f"Expected qty=500, got {qty}")
        except Exception as e:
            log_fail("Stock not deducted when tracking disabled", str(e))

        # ===== Test 5: Manual stock adjustment =====
        print("\n[TEST 5] Manual stock adjustment via PUT")
        try:
            # Use prod1 (current qty=98)
            r = requests.put(f"{BASE_URL}/produtos/{prod1['id']}", headers=headers_a,
                           json={"estoque_quantidade": 50})
            if r.status_code != 200:
                raise Exception(f"Failed to adjust: {r.status_code} {r.text}")
            upd = r.json()
            if upd.get("estoque_quantidade") == 50:
                log_pass("Manual stock adjustment: qty updated to 50")
            else:
                log_fail("Manual stock adjustment",
                        f"Expected qty=50, got {upd.get('estoque_quantidade')}")
        except Exception as e:
            log_fail("Manual stock adjustment", str(e))

        # ===== Test 6: Multi-tenant isolation =====
        print("\n[TEST 6] Multi-tenant isolation")
        try:
            prods_a = listar_produtos(headers_a)
            prods_b = listar_produtos(headers_b)
            prod_ids_a = {p["id"] for p in prods_a}
            prod_ids_b = {p["id"] for p in prods_b}

            shared_ids = prod_ids_a & prod_ids_b
            if not shared_ids:
                log_pass(f"Multi-tenant isolation: empresa B doesn't see empresa A products")
            else:
                log_fail("Multi-tenant isolation",
                        f"Empresa B can see {len(shared_ids)} of empresa A's products")
        except Exception as e:
            log_fail("Multi-tenant isolation", str(e), critical=True)

        # ===== Test 7: List low-stock products (if endpoint exists) =====
        print("\n[TEST 7] Identify low-stock products")
        try:
            # Create product below minimum
            prod_low = criar_produto(headers_a, "Sal Fino", 8.00,
                                    estoque_habilitado=True, estoque_quantidade=2, estoque_minimo=5)
            prods = listar_produtos(headers_a)
            baixos = [p for p in prods if p.get("estoque_habilitado") and p.get("estoque_quantidade", 0) <= p.get("estoque_minimo", 0)]
            if any(p["id"] == prod_low["id"] for p in baixos):
                log_pass(f"Low-stock detection: found {len(baixos)} products below minimum")
            else:
                log_fail("Low-stock detection", f"Created product not in low-stock list")
        except Exception as e:
            log_fail("Low-stock detection", str(e))

        # ===== Test 8: Fractional stock quantities (numeric precision) =====
        print("\n[TEST 8] Fractional stock quantities")
        try:
            prod_frac = criar_produto(headers_a, "Cafe Grao", 12.50,
                                     estoque_habilitado=True, estoque_quantidade=10.5, estoque_minimo=2.25)
            if prod_frac.get("estoque_quantidade") == 10.5:
                log_pass("Fractional stock supported (qty=10.5)")
            else:
                log_fail("Fractional stock",
                        f"Expected qty=10.5, got {prod_frac.get('estoque_quantidade')}")
        except Exception as e:
            log_fail("Fractional stock", str(e))

        # ===== Test 9: GET /produtos/estoque-baixo =====
        # Endpoint que alimenta o card do Dashboard E o alerta global (popup +
        # som) adicionado em 2026-08-18. Estava sem nenhuma cobertura ate
        # entao — mesmo padrao que deixou o bug de /entregadores passar cinco
        # dias sem ser notado.
        print("\n[TEST 9] GET /produtos/estoque-baixo")
        try:
            headers_c, _ = criar_empresa("Estoque Baixo QA")

            # A regra do alerta e "no minimo OU abaixo", entao o caso de
            # igualdade exata e o que mais importa travar: um `<` no lugar de
            # `<=` deixaria de avisar justamente no ponto de virada.
            p_igual = criar_produto(headers_c, "No Minimo Exato", 10.0,
                                    estoque_habilitado=True, estoque_quantidade=5, estoque_minimo=5)
            p_abaixo = criar_produto(headers_c, "Abaixo do Minimo", 10.0,
                                     estoque_habilitado=True, estoque_quantidade=1, estoque_minimo=3)
            p_ok = criar_produto(headers_c, "Estoque Folgado", 10.0,
                                 estoque_habilitado=True, estoque_quantidade=50, estoque_minimo=5)
            # Sem controle de estoque: quantidade baixa nao significa nada aqui,
            # e alertar sobre ele seria alarme falso permanente.
            p_sem = criar_produto(headers_c, "Sem Controle", 10.0,
                                  estoque_habilitado=False, estoque_quantidade=0, estoque_minimo=99)

            resp = requests.get(f"{BASE_URL}/produtos/estoque-baixo", headers=headers_c)
            if resp.status_code != 200:
                log_fail("GET /produtos/estoque-baixo", f"Status {resp.status_code}: {resp.text}", critical=True)
            else:
                nomes = [p["nome"] for p in resp.json().get("produtos", [])]

                if "No Minimo Exato" in nomes:
                    log_pass("estoque-baixo inclui produto EXATAMENTE no minimo")
                else:
                    log_fail("estoque-baixo no minimo exato",
                             f"'No Minimo Exato' (qtd=5, min=5) deveria alertar; veio {nomes}", critical=True)

                if "Abaixo do Minimo" in nomes:
                    log_pass("estoque-baixo inclui produto abaixo do minimo")
                else:
                    log_fail("estoque-baixo abaixo do minimo", f"esperado na lista, veio {nomes}", critical=True)

                if "Estoque Folgado" not in nomes:
                    log_pass("estoque-baixo ignora produto com estoque acima do minimo")
                else:
                    log_fail("estoque-baixo folgado", "produto com estoque suficiente nao deveria alertar")

                if "Sem Controle" not in nomes:
                    log_pass("estoque-baixo ignora produto com controle desabilitado")
                else:
                    log_fail("estoque-baixo sem controle",
                             "produto com estoque_habilitado=false nao deveria alertar")

            # Isolamento: alerta de uma empresa nunca pode vazar para outra.
            resp_b = requests.get(f"{BASE_URL}/produtos/estoque-baixo", headers=headers_b)
            nomes_b = [p["nome"] for p in resp_b.json().get("produtos", [])]
            if "No Minimo Exato" not in nomes_b and "Abaixo do Minimo" not in nomes_b:
                log_pass("estoque-baixo isolado por empresa (multi-tenant)")
            else:
                log_fail("estoque-baixo multi-tenant",
                         f"empresa B enxergou produto da empresa C: {nomes_b}", critical=True)
        except Exception as e:
            log_fail("GET /produtos/estoque-baixo", str(e), critical=True)

        # ===== Summary =====
        print_section("TEST SUMMARY")
        print(f"✅ Passed: {len(results['passed'])}")
        print(f"❌ Failed: {len(results['failed'])}")
        if results['critical_failures']:
            print(f"🔴 Critical failures: {len(results['critical_failures'])}")

        if results["failed"]:
            print("\nFailed tests:")
            for f in results["failed"]:
                print(f"  - {f['teste']}: {f['motivo']}")

        return 0 if not results["failed"] else 1

    except Exception as e:
        print(f"\n🔴 FATAL ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)
