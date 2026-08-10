#!/usr/bin/env python3
"""
Restaurant OS - Backend API Test Suite
Tests all backend endpoints with focus on:
- Auth & Seed
- Multitenancy isolation
- CRUD operations
- Pedidos -> Receita business rule
- Financeiro & Dashboard
- RBAC, Auditoria, Integracoes
"""

import requests
import json
import random
import string
import os
from datetime import datetime

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

# Test results tracking
results = {
    "passed": [],
    "failed": [],
    "critical_failures": []
}

def log_pass(test_name):
    print(f"✅ PASS: {test_name}")
    results["passed"].append(test_name)

def log_fail(test_name, reason, critical=False):
    print(f"❌ FAIL: {test_name}")
    print(f"   Reason: {reason}")
    results["failed"].append({"test": test_name, "reason": reason})
    if critical:
        results["critical_failures"].append({"test": test_name, "reason": reason})

def random_email():
    """Generate unique email for testing"""
    rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"restaurante.{rand}@teste.com"

def print_section(title):
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")

# Test data storage
tenant_a = {}
tenant_b = {}

try:
    print_section("1. AUTH & SEED - TENANT A")
    
    # 1.1 Register Tenant A
    print("Testing POST /auth/register (Tenant A)...")
    tenant_a_email = random_email()
    register_data = {
        "empresa_nome": "Restaurante Bella Vista",
        "nome": "Maria Silva",
        "email": tenant_a_email,
        "senha": "senha_segura_123"
    }
    
    resp = requests.post(f"{BASE_URL}/auth/register", json=register_data)
    if resp.status_code == 200:
        data = resp.json()
        if "token" in data and "usuario" in data and "empresa" in data and "permissions" in data:
            tenant_a["token"] = data["token"]
            tenant_a["usuario"] = data["usuario"]
            tenant_a["empresa"] = data["empresa"]
            tenant_a["email"] = tenant_a_email
            tenant_a["senha"] = "senha_segura_123"
            log_pass("Register Tenant A - returns 200 with token, usuario, empresa, permissions")
            print(f"   Empresa ID: {tenant_a['empresa']['id']}")
            print(f"   Usuario ID: {tenant_a['usuario']['id']}")
        else:
            log_fail("Register Tenant A - missing required fields in response", str(data), critical=True)
    else:
        log_fail("Register Tenant A", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 1.2 Login Tenant A
    print("\nTesting POST /auth/login (Tenant A)...")
    login_data = {
        "email": tenant_a["email"],
        "senha": tenant_a["senha"]
    }
    resp = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    if resp.status_code == 200:
        data = resp.json()
        if "token" in data:
            log_pass("Login Tenant A - returns 200 with token")
        else:
            log_fail("Login Tenant A - missing token", str(data))
    else:
        log_fail("Login Tenant A", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 1.3 GET /auth/me
    print("\nTesting GET /auth/me (Tenant A)...")
    headers = {"Authorization": f"Bearer {tenant_a['token']}"}
    resp = requests.get(f"{BASE_URL}/auth/me", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        if "usuario" in data and "empresa" in data and "permissions" in data and "roles" in data:
            log_pass("GET /auth/me - returns 200 with usuario, empresa, permissions, roles")
        else:
            log_fail("GET /auth/me - missing required fields", str(data))
    else:
        log_fail("GET /auth/me", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 1.4 Test 401 without token
    print("\nTesting 401 without token...")
    resp = requests.get(f"{BASE_URL}/auth/me")
    if resp.status_code == 401:
        log_pass("Protected route without token - returns 401")
    else:
        log_fail("Protected route without token", f"Expected 401, got {resp.status_code}")
    
    # 1.5 Test 409 duplicate email
    print("\nTesting 409 duplicate email...")
    resp = requests.post(f"{BASE_URL}/auth/register", json=register_data)
    if resp.status_code == 409:
        log_pass("Register duplicate email - returns 409")
    else:
        log_fail("Register duplicate email", f"Expected 409, got {resp.status_code}")
    
    print_section("2. AUTH & SEED - TENANT B")
    
    # 2.1 Register Tenant B
    print("Testing POST /auth/register (Tenant B)...")
    tenant_b_email = random_email()
    register_data_b = {
        "empresa_nome": "Pizzaria Napolitana",
        "nome": "João Santos",
        "email": tenant_b_email,
        "senha": "senha_forte_456"
    }
    
    resp = requests.post(f"{BASE_URL}/auth/register", json=register_data_b)
    if resp.status_code == 200:
        data = resp.json()
        if "token" in data and "usuario" in data and "empresa" in data:
            tenant_b["token"] = data["token"]
            tenant_b["usuario"] = data["usuario"]
            tenant_b["empresa"] = data["empresa"]
            tenant_b["email"] = tenant_b_email
            tenant_b["senha"] = "senha_forte_456"
            log_pass("Register Tenant B - returns 200 with token, usuario, empresa")
            print(f"   Empresa ID: {tenant_b['empresa']['id']}")
            print(f"   Usuario ID: {tenant_b['usuario']['id']}")
        else:
            log_fail("Register Tenant B - missing required fields", str(data), critical=True)
    else:
        log_fail("Register Tenant B", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    print_section("3. MULTITENANCY ISOLATION (CRITICAL)")
    
    # 3.1 Get produtos from both tenants
    print("Testing multitenancy isolation for produtos...")
    headers_a = {"Authorization": f"Bearer {tenant_a['token']}"}
    headers_b = {"Authorization": f"Bearer {tenant_b['token']}"}
    
    resp_a = requests.get(f"{BASE_URL}/produtos", headers=headers_a)
    resp_b = requests.get(f"{BASE_URL}/produtos", headers=headers_b)
    
    if resp_a.status_code == 200 and resp_b.status_code == 200:
        produtos_a = resp_a.json()
        produtos_b = resp_b.json()
        
        # Check that both have seed data
        if len(produtos_a) > 0 and len(produtos_b) > 0:
            # Check that produto IDs don't overlap
            ids_a = set(p["id"] for p in produtos_a)
            ids_b = set(p["id"] for p in produtos_b)
            overlap = ids_a.intersection(ids_b)
            
            if len(overlap) == 0:
                log_pass("Multitenancy produtos - Tenant A and B have isolated data")
                print(f"   Tenant A: {len(produtos_a)} produtos")
                print(f"   Tenant B: {len(produtos_b)} produtos")
                print(f"   No ID overlap: ✓")
            else:
                log_fail("Multitenancy produtos - DATA LEAK DETECTED", f"Overlapping IDs: {overlap}", critical=True)
        else:
            log_fail("Multitenancy produtos - seed data missing", f"A: {len(produtos_a)}, B: {len(produtos_b)}", critical=True)
    else:
        log_fail("Multitenancy produtos", f"Status A: {resp_a.status_code}, B: {resp_b.status_code}", critical=True)
    
    # 3.2 Get clientes from both tenants
    print("\nTesting multitenancy isolation for clientes...")
    resp_a = requests.get(f"{BASE_URL}/clientes", headers=headers_a)
    resp_b = requests.get(f"{BASE_URL}/clientes", headers=headers_b)
    
    if resp_a.status_code == 200 and resp_b.status_code == 200:
        clientes_a = resp_a.json()
        clientes_b = resp_b.json()
        
        if len(clientes_a) > 0 and len(clientes_b) > 0:
            ids_a = set(c["id"] for c in clientes_a)
            ids_b = set(c["id"] for c in clientes_b)
            overlap = ids_a.intersection(ids_b)
            
            if len(overlap) == 0:
                log_pass("Multitenancy clientes - Tenant A and B have isolated data")
                print(f"   Tenant A: {len(clientes_a)} clientes")
                print(f"   Tenant B: {len(clientes_b)} clientes")
            else:
                log_fail("Multitenancy clientes - DATA LEAK DETECTED", f"Overlapping IDs: {overlap}", critical=True)
        else:
            log_fail("Multitenancy clientes - seed data missing", f"A: {len(clientes_a)}, B: {len(clientes_b)}")
    else:
        log_fail("Multitenancy clientes", f"Status A: {resp_a.status_code}, B: {resp_b.status_code}", critical=True)
    
    # 3.3 Get pedidos from both tenants
    print("\nTesting multitenancy isolation for pedidos...")
    resp_a = requests.get(f"{BASE_URL}/pedidos", headers=headers_a)
    resp_b = requests.get(f"{BASE_URL}/pedidos", headers=headers_b)
    
    if resp_a.status_code == 200 and resp_b.status_code == 200:
        pedidos_a = resp_a.json()
        pedidos_b = resp_b.json()
        
        if len(pedidos_a) > 0 and len(pedidos_b) > 0:
            ids_a = set(p["id"] for p in pedidos_a)
            ids_b = set(p["id"] for p in pedidos_b)
            overlap = ids_a.intersection(ids_b)
            
            if len(overlap) == 0:
                log_pass("Multitenancy pedidos - Tenant A and B have isolated data")
                print(f"   Tenant A: {len(pedidos_a)} pedidos")
                print(f"   Tenant B: {len(pedidos_b)} pedidos")
            else:
                log_fail("Multitenancy pedidos - DATA LEAK DETECTED", f"Overlapping IDs: {overlap}", critical=True)
        else:
            log_fail("Multitenancy pedidos - seed data missing", f"A: {len(pedidos_a)}, B: {len(pedidos_b)}")
    else:
        log_fail("Multitenancy pedidos", f"Status A: {resp_a.status_code}, B: {resp_b.status_code}", critical=True)
    
    print_section("4. CARDAPIO & CLIENTES CRUD (Tenant A)")
    
    # 4.1 GET categorias (should have seed data)
    print("Testing GET /categorias...")
    resp = requests.get(f"{BASE_URL}/categorias", headers=headers_a)
    if resp.status_code == 200:
        categorias = resp.json()
        if len(categorias) > 0:
            tenant_a["categorias"] = categorias
            log_pass(f"GET /categorias - returns {len(categorias)} categorias from seed")
        else:
            log_fail("GET /categorias - no seed data", "Expected categorias from seed")
    else:
        log_fail("GET /categorias", f"Status {resp.status_code}: {resp.text}")
    
    # 4.2 POST categoria
    print("\nTesting POST /categorias...")
    new_cat = {"nome": "Especiais da Casa", "ordem": 10}
    resp = requests.post(f"{BASE_URL}/categorias", json=new_cat, headers=headers_a)
    if resp.status_code == 201:
        cat = resp.json()
        if "id" in cat and cat["nome"] == "Especiais da Casa":
            tenant_a["new_categoria_id"] = cat["id"]
            log_pass("POST /categorias - creates categoria and returns 201")
        else:
            log_fail("POST /categorias - invalid response", str(cat))
    else:
        log_fail("POST /categorias", f"Status {resp.status_code}: {resp.text}")
    
    # 4.3 POST produto
    print("\nTesting POST /produtos...")
    new_prod = {
        "nome": "Picanha na Chapa",
        "preco": 89.90,
        "categoria_id": tenant_a.get("new_categoria_id"),
        "descricao": "Picanha premium grelhada"
    }
    resp = requests.post(f"{BASE_URL}/produtos", json=new_prod, headers=headers_a)
    if resp.status_code == 201:
        prod = resp.json()
        if "id" in prod and prod["nome"] == "Picanha na Chapa":
            tenant_a["new_produto_id"] = prod["id"]
            log_pass("POST /produtos - creates produto and returns 201")
        else:
            log_fail("POST /produtos - invalid response", str(prod))
    else:
        log_fail("POST /produtos", f"Status {resp.status_code}: {resp.text}")
    
    # 4.4 PUT produto
    print("\nTesting PUT /produtos/:id...")
    if "new_produto_id" in tenant_a:
        update_prod = {"preco": 94.90, "descricao": "Picanha premium grelhada com molho especial"}
        resp = requests.put(f"{BASE_URL}/produtos/{tenant_a['new_produto_id']}", json=update_prod, headers=headers_a)
        if resp.status_code == 200:
            prod = resp.json()
            if prod.get("preco") == 94.90:
                log_pass("PUT /produtos/:id - updates produto")
            else:
                log_fail("PUT /produtos/:id - update not applied", str(prod))
        else:
            log_fail("PUT /produtos/:id", f"Status {resp.status_code}: {resp.text}")
    
    # 4.5 DELETE produto
    print("\nTesting DELETE /produtos/:id...")
    if "new_produto_id" in tenant_a:
        resp = requests.delete(f"{BASE_URL}/produtos/{tenant_a['new_produto_id']}", headers=headers_a)
        if resp.status_code == 200:
            log_pass("DELETE /produtos/:id - deletes produto")
        else:
            log_fail("DELETE /produtos/:id", f"Status {resp.status_code}: {resp.text}")
    
    # 4.6 POST cliente
    print("\nTesting POST /clientes...")
    new_cliente = {
        "nome": "Carlos Mendes",
        "telefone": "11987654321",
        "email": "carlos.mendes@email.com",
        "endereco": "Rua das Flores, 123"
    }
    resp = requests.post(f"{BASE_URL}/clientes", json=new_cliente, headers=headers_a)
    if resp.status_code == 201:
        cliente = resp.json()
        if "id" in cliente and cliente["nome"] == "Carlos Mendes":
            tenant_a["new_cliente_id"] = cliente["id"]
            log_pass("POST /clientes - creates cliente and returns 201")
        else:
            log_fail("POST /clientes - invalid response", str(cliente))
    else:
        log_fail("POST /clientes", f"Status {resp.status_code}: {resp.text}")
    
    # 4.7 PUT cliente
    print("\nTesting PUT /clientes/:id...")
    if "new_cliente_id" in tenant_a:
        update_cliente = {"telefone": "11999887766"}
        resp = requests.put(f"{BASE_URL}/clientes/{tenant_a['new_cliente_id']}", json=update_cliente, headers=headers_a)
        if resp.status_code == 200:
            cliente = resp.json()
            if cliente.get("telefone") == "11999887766":
                log_pass("PUT /clientes/:id - updates cliente")
            else:
                log_fail("PUT /clientes/:id - update not applied", str(cliente))
        else:
            log_fail("PUT /clientes/:id", f"Status {resp.status_code}: {resp.text}")
    
    # 4.8 DELETE cliente
    print("\nTesting DELETE /clientes/:id...")
    if "new_cliente_id" in tenant_a:
        resp = requests.delete(f"{BASE_URL}/clientes/{tenant_a['new_cliente_id']}", headers=headers_a)
        if resp.status_code == 200:
            log_pass("DELETE /clientes/:id - deletes cliente")
        else:
            log_fail("DELETE /clientes/:id", f"Status {resp.status_code}: {resp.text}")
    
    # 4.9 DELETE categoria
    print("\nTesting DELETE /categorias/:id...")
    if "new_categoria_id" in tenant_a:
        resp = requests.delete(f"{BASE_URL}/categorias/{tenant_a['new_categoria_id']}", headers=headers_a)
        if resp.status_code == 200:
            log_pass("DELETE /categorias/:id - deletes categoria")
        else:
            log_fail("DELETE /categorias/:id", f"Status {resp.status_code}: {resp.text}")
    
    print_section("5. PEDIDOS + FINANCIAL RULE (CRITICAL)")
    
    # 5.1 Get initial transacoes count
    print("Getting initial transacoes count...")
    resp = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers_a)
    if resp.status_code == 200:
        initial_transacoes = resp.json()
        initial_count = len(initial_transacoes)
        print(f"   Initial transacoes count: {initial_count}")
    else:
        log_fail("GET /financeiro/transacoes (initial)", f"Status {resp.status_code}: {resp.text}")
        initial_count = 0
    
    # 5.2 Get a produto and cliente from seed for the pedido
    resp_prods = requests.get(f"{BASE_URL}/produtos", headers=headers_a)
    resp_clientes = requests.get(f"{BASE_URL}/clientes", headers=headers_a)
    
    if resp_prods.status_code == 200 and resp_clientes.status_code == 200:
        produtos = resp_prods.json()
        clientes = resp_clientes.json()
        
        if len(produtos) > 0 and len(clientes) > 0:
            # Pick first produto and cliente
            produto = produtos[0]
            cliente = clientes[0]
            
            # 5.3 POST pedido without itens (should fail with 400)
            print("\nTesting POST /pedidos without itens (should fail)...")
            bad_pedido = {
                "cliente_id": cliente["id"],
                "tipo": "balcao",
                "pagamento": "pix",
                "itens": []
            }
            resp = requests.post(f"{BASE_URL}/pedidos", json=bad_pedido, headers=headers_a)
            if resp.status_code == 400:
                log_pass("POST /pedidos without itens - returns 400")
            else:
                log_fail("POST /pedidos without itens", f"Expected 400, got {resp.status_code}")
            
            # 5.4 POST pedido with itens
            print("\nTesting POST /pedidos with itens...")
            new_pedido = {
                "cliente_id": cliente["id"],
                "tipo": "delivery",
                "pagamento": "cartao",
                "itens": [
                    {
                        "produto_id": produto["id"],
                        "nome": produto["nome"],
                        "preco": produto["preco"],
                        "quantidade": 2
                    }
                ]
            }
            resp = requests.post(f"{BASE_URL}/pedidos", json=new_pedido, headers=headers_a)
            if resp.status_code == 201:
                pedido = resp.json()
                if "id" in pedido and "numero" in pedido and "total" in pedido:
                    tenant_a["new_pedido_id"] = pedido["id"]
                    tenant_a["pedido_total"] = pedido["total"]
                    tenant_a["pedido_cliente_id"] = cliente["id"]
                    log_pass(f"POST /pedidos - creates pedido #{pedido['numero']} with total {pedido['total']}")
                    print(f"   Pedido ID: {pedido['id']}")
                    print(f"   Total: R$ {pedido['total']}")
                else:
                    log_fail("POST /pedidos - missing fields", str(pedido))
            else:
                log_fail("POST /pedidos", f"Status {resp.status_code}: {resp.text}")
            
            # 5.5 Get cliente metrics before concluir
            print("\nGetting cliente metrics before concluir...")
            resp = requests.get(f"{BASE_URL}/clientes", headers=headers_a)
            if resp.status_code == 200:
                clientes_list = resp.json()
                cliente_before = next((c for c in clientes_list if c["id"] == cliente["id"]), None)
                if cliente_before:
                    tenant_a["cliente_total_pedidos_before"] = cliente_before.get("total_pedidos", 0)
                    tenant_a["cliente_total_gasto_before"] = cliente_before.get("total_gasto", 0)
                    print(f"   Cliente total_pedidos before: {tenant_a['cliente_total_pedidos_before']}")
                    print(f"   Cliente total_gasto before: {tenant_a['cliente_total_gasto_before']}")
            
            # 5.6 PUT pedido status to 'concluido' (CRITICAL BUSINESS RULE)
            print("\nTesting PUT /pedidos/:id status='concluido' (CRITICAL)...")
            if "new_pedido_id" in tenant_a:
                update_status = {"status": "concluido"}
                resp = requests.put(f"{BASE_URL}/pedidos/{tenant_a['new_pedido_id']}", json=update_status, headers=headers_a)
                if resp.status_code == 200:
                    pedido_updated = resp.json()
                    if pedido_updated.get("status") == "concluido":
                        log_pass("PUT /pedidos/:id status='concluido' - updates status")
                        
                        # 5.7 Verify that a receita transaction was created
                        print("\nVerifying receita transaction was created...")
                        resp = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers_a)
                        if resp.status_code == 200:
                            transacoes = resp.json()
                            new_count = len(transacoes)
                            
                            # Find the new receita transaction
                            receita_found = False
                            for t in transacoes:
                                if t.get("tipo") == "receita" and t.get("pedido_id") == tenant_a["new_pedido_id"]:
                                    receita_found = True
                                    if abs(t.get("valor", 0) - tenant_a["pedido_total"]) < 0.01:
                                        log_pass(f"Receita transaction created with correct value: R$ {t['valor']}")
                                    else:
                                        log_fail("Receita transaction value mismatch", 
                                                f"Expected {tenant_a['pedido_total']}, got {t.get('valor')}", critical=True)
                                    break
                            
                            if not receita_found:
                                log_fail("Receita transaction NOT created", 
                                        f"No receita found for pedido_id {tenant_a['new_pedido_id']}", critical=True)
                        else:
                            log_fail("GET /financeiro/transacoes (after concluir)", f"Status {resp.status_code}")
                        
                        # 5.8 Verify cliente metrics were updated
                        print("\nVerifying cliente metrics were updated...")
                        resp = requests.get(f"{BASE_URL}/clientes", headers=headers_a)
                        if resp.status_code == 200:
                            clientes_list = resp.json()
                            cliente_after = next((c for c in clientes_list if c["id"] == tenant_a["pedido_cliente_id"]), None)
                            if cliente_after:
                                total_pedidos_after = cliente_after.get("total_pedidos", 0)
                                total_gasto_after = cliente_after.get("total_gasto", 0)
                                
                                print(f"   Cliente total_pedidos after: {total_pedidos_after}")
                                print(f"   Cliente total_gasto after: {total_gasto_after}")
                                
                                if total_pedidos_after == tenant_a["cliente_total_pedidos_before"] + 1:
                                    log_pass("Cliente total_pedidos incremented correctly")
                                else:
                                    log_fail("Cliente total_pedidos NOT incremented", 
                                            f"Before: {tenant_a['cliente_total_pedidos_before']}, After: {total_pedidos_after}", 
                                            critical=True)
                                
                                expected_gasto = tenant_a["cliente_total_gasto_before"] + tenant_a["pedido_total"]
                                if abs(total_gasto_after - expected_gasto) < 0.01:
                                    log_pass(f"Cliente total_gasto updated correctly: R$ {total_gasto_after}")
                                else:
                                    log_fail("Cliente total_gasto NOT updated correctly", 
                                            f"Expected {expected_gasto}, got {total_gasto_after}", critical=True)
                    else:
                        log_fail("PUT /pedidos/:id status='concluido' - status not updated", str(pedido_updated))
                else:
                    log_fail("PUT /pedidos/:id status='concluido'", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    print_section("6. FINANCEIRO & DASHBOARD")
    
    # 6.1 GET /financeiro/resumo
    print("Testing GET /financeiro/resumo...")
    resp = requests.get(f"{BASE_URL}/financeiro/resumo", headers=headers_a)
    if resp.status_code == 200:
        resumo = resp.json()
        required_fields = ["receitas", "despesas", "saldo", "serie"]
        if all(field in resumo for field in required_fields):
            if isinstance(resumo["serie"], list) and len(resumo["serie"]) == 7:
                log_pass(f"GET /financeiro/resumo - returns resumo with 7-day serie")
                print(f"   Receitas: R$ {resumo['receitas']}")
                print(f"   Despesas: R$ {resumo['despesas']}")
                print(f"   Saldo: R$ {resumo['saldo']}")
            else:
                log_fail("GET /financeiro/resumo - serie not 7 days", f"Serie length: {len(resumo.get('serie', []))}")
        else:
            log_fail("GET /financeiro/resumo - missing fields", str(resumo))
    else:
        log_fail("GET /financeiro/resumo", f"Status {resp.status_code}: {resp.text}")
    
    # 6.2 POST /financeiro/transacoes (despesa)
    print("\nTesting POST /financeiro/transacoes (despesa)...")
    new_transacao = {
        "tipo": "despesa",
        "categoria": "Fornecedores",
        "descricao": "Compra de ingredientes",
        "valor": 450.00
    }
    resp = requests.post(f"{BASE_URL}/financeiro/transacoes", json=new_transacao, headers=headers_a)
    if resp.status_code == 201:
        transacao = resp.json()
        if "id" in transacao and transacao["tipo"] == "despesa":
            log_pass("POST /financeiro/transacoes - creates despesa transaction")
        else:
            log_fail("POST /financeiro/transacoes - invalid response", str(transacao))
    else:
        log_fail("POST /financeiro/transacoes", f"Status {resp.status_code}: {resp.text}")
    
    # 6.3 GET /dashboard/metrics
    print("\nTesting GET /dashboard/metrics...")
    resp = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers_a)
    if resp.status_code == 200:
        metrics = resp.json()
        required_fields = ["faturamentoHoje", "pedidosHoje", "ticketMedio", "totalClientes", 
                          "totalProdutos", "serie", "topProdutos", "recentes", "porStatus"]
        if all(field in metrics for field in required_fields):
            log_pass("GET /dashboard/metrics - returns all required metrics")
            print(f"   Faturamento Hoje: R$ {metrics['faturamentoHoje']}")
            print(f"   Pedidos Hoje: {metrics['pedidosHoje']}")
            print(f"   Ticket Médio: R$ {metrics['ticketMedio']}")
            print(f"   Total Clientes: {metrics['totalClientes']}")
            print(f"   Total Produtos: {metrics['totalProdutos']}")
        else:
            missing = [f for f in required_fields if f not in metrics]
            log_fail("GET /dashboard/metrics - missing fields", f"Missing: {missing}")
    else:
        log_fail("GET /dashboard/metrics", f"Status {resp.status_code}: {resp.text}")
    
    print_section("7. USUARIOS/RBAC")
    
    # 7.1 GET /usuarios
    print("Testing GET /usuarios...")
    resp = requests.get(f"{BASE_URL}/usuarios", headers=headers_a)
    if resp.status_code == 200:
        usuarios = resp.json()
        if len(usuarios) > 0:
            log_pass(f"GET /usuarios - returns {len(usuarios)} usuarios")
        else:
            log_fail("GET /usuarios - no usuarios", "Expected at least owner")
    else:
        log_fail("GET /usuarios", f"Status {resp.status_code}: {resp.text}")
    
    # 7.2 POST /usuarios (create ATENDENTE)
    print("\nTesting POST /usuarios (create ATENDENTE)...")
    new_usuario = {
        "nome": "Ana Costa",
        "email": f"ana.costa.{random.randint(1000,9999)}@restaurante.com",
        "senha": "senha123",
        "papel": "ATENDENTE"
    }
    resp = requests.post(f"{BASE_URL}/usuarios", json=new_usuario, headers=headers_a)
    if resp.status_code == 201:
        usuario = resp.json()
        if "id" in usuario and usuario["papel"] == "ATENDENTE":
            tenant_a["new_usuario_id"] = usuario["id"]
            log_pass("POST /usuarios - creates ATENDENTE user")
        else:
            log_fail("POST /usuarios - invalid response", str(usuario))
    else:
        log_fail("POST /usuarios", f"Status {resp.status_code}: {resp.text}")
    
    # 7.3 PUT /usuarios/:id
    print("\nTesting PUT /usuarios/:id...")
    if "new_usuario_id" in tenant_a:
        update_usuario = {"nome": "Ana Costa Silva"}
        resp = requests.put(f"{BASE_URL}/usuarios/{tenant_a['new_usuario_id']}", json=update_usuario, headers=headers_a)
        if resp.status_code == 200:
            usuario = resp.json()
            if usuario.get("nome") == "Ana Costa Silva":
                log_pass("PUT /usuarios/:id - updates usuario")
            else:
                log_fail("PUT /usuarios/:id - update not applied", str(usuario))
        else:
            log_fail("PUT /usuarios/:id", f"Status {resp.status_code}: {resp.text}")
    
    # 7.4 DELETE self (should fail with 400)
    print("\nTesting DELETE /usuarios/:id (self - should fail)...")
    resp = requests.delete(f"{BASE_URL}/usuarios/{tenant_a['usuario']['id']}", headers=headers_a)
    if resp.status_code == 400:
        log_pass("DELETE /usuarios/:id (self) - returns 400")
    else:
        log_fail("DELETE /usuarios/:id (self)", f"Expected 400, got {resp.status_code}")
    
    # 7.5 DELETE other usuario
    print("\nTesting DELETE /usuarios/:id (other)...")
    if "new_usuario_id" in tenant_a:
        resp = requests.delete(f"{BASE_URL}/usuarios/{tenant_a['new_usuario_id']}", headers=headers_a)
        if resp.status_code == 200:
            log_pass("DELETE /usuarios/:id - deletes usuario")
        else:
            log_fail("DELETE /usuarios/:id", f"Status {resp.status_code}: {resp.text}")
    
    print_section("8. EMPRESA CONFIG")
    
    # 8.1 GET /empresa
    print("Testing GET /empresa...")
    resp = requests.get(f"{BASE_URL}/empresa", headers=headers_a)
    if resp.status_code == 200:
        empresa = resp.json()
        if "id" in empresa and "nome" in empresa:
            log_pass("GET /empresa - returns empresa data")
        else:
            log_fail("GET /empresa - invalid response", str(empresa))
    else:
        log_fail("GET /empresa", f"Status {resp.status_code}: {resp.text}")
    
    # 8.2 PUT /empresa
    print("\nTesting PUT /empresa...")
    update_empresa = {
        "telefone": "1133334444",
        "endereco": "Av. Paulista, 1000"
    }
    resp = requests.put(f"{BASE_URL}/empresa", json=update_empresa, headers=headers_a)
    if resp.status_code == 200:
        empresa = resp.json()
        if empresa.get("telefone") == "1133334444":
            log_pass("PUT /empresa - updates empresa")
        else:
            log_fail("PUT /empresa - update not applied", str(empresa))
    else:
        log_fail("PUT /empresa", f"Status {resp.status_code}: {resp.text}")
    
    print_section("9. AUDITORIA")
    
    # 9.1 GET /auditoria
    print("Testing GET /auditoria...")
    resp = requests.get(f"{BASE_URL}/auditoria", headers=headers_a)
    if resp.status_code == 200:
        auditoria = resp.json()
        if len(auditoria) > 0:
            log_pass(f"GET /auditoria - returns {len(auditoria)} audit records")
            # Check for expected actions
            acoes = set(a.get("acao") for a in auditoria)
            expected_acoes = ["register", "create", "update"]
            found = [a for a in expected_acoes if a in acoes]
            print(f"   Found actions: {found}")
        else:
            log_fail("GET /auditoria - no audit records", "Expected audit records from operations")
    else:
        log_fail("GET /auditoria", f"Status {resp.status_code}: {resp.text}")
    
    print_section("10. INTEGRACOES")
    
    # 10.1 GET /integracoes
    print("Testing GET /integracoes...")
    resp = requests.get(f"{BASE_URL}/integracoes", headers=headers_a)
    if resp.status_code == 200:
        integracoes = resp.json()
        if "evolution" in integracoes and "n8n" in integracoes:
            log_pass("GET /integracoes - returns evolution and n8n")
            print(f"   Evolution status: {integracoes['evolution'].get('status') if integracoes['evolution'] else 'null'}")
            print(f"   n8n status: {integracoes['n8n'].get('status') if integracoes['n8n'] else 'null'}")
        else:
            log_fail("GET /integracoes - missing evolution or n8n", str(integracoes))
    else:
        log_fail("GET /integracoes", f"Status {resp.status_code}: {resp.text}")
    
    # 10.2 PUT /integracoes/evolution
    print("\nTesting PUT /integracoes/evolution...")
    evolution_config = {
        "serverUrl": "https://evolution.example.com",
        "apiKey": "test_key_123",
        "instance": "bella-vista"
    }
    resp = requests.put(f"{BASE_URL}/integracoes/evolution", json=evolution_config, headers=headers_a)
    if resp.status_code == 200:
        integ = resp.json()
        if integ.get("status") == "configurado":
            log_pass("PUT /integracoes/evolution - updates config and status")
        else:
            log_fail("PUT /integracoes/evolution - status not updated", str(integ))
    else:
        log_fail("PUT /integracoes/evolution", f"Status {resp.status_code}: {resp.text}")
    
    # 10.3 POST /integracoes/evolution/testar (should fail - no valid credentials)
    print("\nTesting POST /integracoes/evolution/testar (should return not connected)...")
    resp = requests.post(f"{BASE_URL}/integracoes/evolution/testar", headers=headers_a)
    if resp.status_code == 200:
        result = resp.json()
        # Should return connected: false or state: error/not_configured
        if result.get("connected") == False or result.get("state") in ["error", "not_configured"]:
            log_pass(f"POST /integracoes/evolution/testar - returns not connected (state: {result.get('state')})")
        else:
            log_fail("POST /integracoes/evolution/testar - should not mock success", 
                    f"Got connected={result.get('connected')}, state={result.get('state')}")
    else:
        log_fail("POST /integracoes/evolution/testar", f"Status {resp.status_code}: {resp.text}")
    
    # 10.4 PUT /integracoes/n8n (without webhook)
    print("\nTesting PUT /integracoes/n8n (without webhook)...")
    n8n_config = {"webhookUrl": "", "apiKey": ""}
    resp = requests.put(f"{BASE_URL}/integracoes/n8n", json=n8n_config, headers=headers_a)
    if resp.status_code == 200:
        integ = resp.json()
        if integ.get("status") == "nao_configurado":
            log_pass("PUT /integracoes/n8n - status nao_configurado without webhook")
        else:
            log_fail("PUT /integracoes/n8n - wrong status", str(integ))
    else:
        log_fail("PUT /integracoes/n8n", f"Status {resp.status_code}: {resp.text}")
    
    # 10.5 POST /integracoes/n8n/testar (should return not connected)
    print("\nTesting POST /integracoes/n8n/testar (should return not connected)...")
    resp = requests.post(f"{BASE_URL}/integracoes/n8n/testar", headers=headers_a)
    if resp.status_code == 200:
        result = resp.json()
        if result.get("connected") == False:
            log_pass("POST /integracoes/n8n/testar - returns connected: false")
        else:
            log_fail("POST /integracoes/n8n/testar - should not mock success", 
                    f"Got connected={result.get('connected')}")
    else:
        log_fail("POST /integracoes/n8n/testar", f"Status {resp.status_code}: {resp.text}")

except Exception as e:
    print(f"\n❌ FATAL ERROR: {str(e)}")
    import traceback
    traceback.print_exc()

# Print summary
print_section("TEST SUMMARY")
print(f"✅ PASSED: {len(results['passed'])}")
print(f"❌ FAILED: {len(results['failed'])}")
print(f"🔴 CRITICAL FAILURES: {len(results['critical_failures'])}")

if results['critical_failures']:
    print("\n🔴 CRITICAL FAILURES:")
    for fail in results['critical_failures']:
        print(f"   - {fail['test']}: {fail['reason']}")

if results['failed']:
    print(f"\n❌ ALL FAILURES:")
    for fail in results['failed']:
        print(f"   - {fail['test']}: {fail['reason']}")

print(f"\n{'='*80}")
if len(results['critical_failures']) == 0:
    print("✅ All critical tests passed!")
else:
    print("🔴 Critical failures detected - backend has issues!")
print(f"{'='*80}\n")
