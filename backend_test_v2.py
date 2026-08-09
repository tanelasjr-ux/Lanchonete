#!/usr/bin/env python3
"""
Restaurant OS v2 - Backend API Test Suite
Tests NEW v2 functionalities:
- Mesas (salao) - configurar, listar, abrir comanda
- Comandas - full flow (itens, desconto, taxa, pagamentos, fechar, transferir)
- Mercado Pago - abstraction (no mocking), webhook validation
- Empresa branding/config with deep merge
- Regression tests (dashboard, pedidos, auditoria)
"""

import requests
import json
import random
import string
from datetime import datetime

# Base URL from .env
BASE_URL = "https://dine-operations.preview.emergentagent.com/api"

# Test results tracking
results = {
    "passed": [],
    "failed": [],
    "critical_failures": []
}

def log_pass(test_name, details=""):
    msg = f"✅ PASS: {test_name}"
    if details:
        msg += f" - {details}"
    print(msg)
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
tenant = {}

try:
    print_section("SETUP - Register & Verify Seed")
    
    # Register tenant
    print("Registering tenant...")
    tenant_email = random_email()
    register_data = {
        "empresa_nome": "Restaurante Bella Vista",
        "nome": "Maria Silva",
        "email": tenant_email,
        "senha": "senha_segura_123"
    }
    
    resp = requests.post(f"{BASE_URL}/auth/register", json=register_data)
    if resp.status_code == 200:
        data = resp.json()
        tenant["token"] = data["token"]
        tenant["usuario"] = data["usuario"]
        tenant["empresa"] = data["empresa"]
        tenant["empresa_id"] = data["empresa"]["id"]
        log_pass("Register tenant", f"Empresa ID: {tenant['empresa_id']}")
    else:
        log_fail("Register tenant", f"Status {resp.status_code}: {resp.text}", critical=True)
        exit(1)
    
    headers = {"Authorization": f"Bearer {tenant['token']}"}
    
    # Verify seed created 8 mesas
    print("\nVerifying seed created 8 mesas...")
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        if len(mesas) == 8:
            log_pass("Seed created 8 mesas", f"Found {len(mesas)} mesas")
            tenant["mesas"] = mesas
            
            # Verify Mesa 02 has a comanda
            mesa_02 = next((m for m in mesas if m["numero"] == 2), None)
            if mesa_02:
                if mesa_02["status"] == "ocupada" and mesa_02.get("comanda"):
                    comanda_info = mesa_02["comanda"]
                    if comanda_info.get("itens_count", 0) > 0 and comanda_info.get("total", 0) > 0:
                        log_pass("Mesa 02 has comanda with items", 
                                f"Status: {mesa_02['status']}, Items: {comanda_info['itens_count']}, Total: {comanda_info['total']}")
                        tenant["mesa_02_comanda_id"] = comanda_info["id"]
                    else:
                        log_fail("Mesa 02 comanda has no items/total", str(comanda_info), critical=True)
                else:
                    log_fail("Mesa 02 not occupied or no comanda", str(mesa_02), critical=True)
            else:
                log_fail("Mesa 02 not found", "Expected Mesa 02 in seed", critical=True)
        else:
            log_fail("Seed mesas count", f"Expected 8, got {len(mesas)}", critical=True)
    else:
        log_fail("GET /mesas", f"Status {resp.status_code}: {resp.text}", critical=True)
        exit(1)
    
    print_section("1. MESAS MODULE")
    
    # 1.1 GET /mesas - verify structure
    print("Testing GET /mesas structure...")
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        if len(mesas) > 0:
            mesa = mesas[0]
            required_fields = ["id", "numero", "nome", "capacidade", "status"]
            if all(f in mesa for f in required_fields):
                log_pass("GET /mesas returns correct structure", 
                        f"Fields: {', '.join(required_fields)}")
            else:
                log_fail("GET /mesas structure", f"Missing fields in: {mesa}")
    else:
        log_fail("GET /mesas", f"Status {resp.status_code}: {resp.text}")
    
    # 1.2 POST /mesas/configurar - increase to 12 mesas
    print("\nTesting POST /mesas/configurar (increase to 12)...")
    config_data = {"quantidade": 12, "capacidade": 4}
    resp = requests.post(f"{BASE_URL}/mesas/configurar", json=config_data, headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        if len(mesas) == 12:
            log_pass("POST /mesas/configurar creates mesas", f"Now have {len(mesas)} mesas")
            tenant["mesas"] = mesas
        else:
            log_fail("POST /mesas/configurar count", f"Expected 12, got {len(mesas)}", critical=True)
    else:
        log_fail("POST /mesas/configurar", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 1.3 Verify GET /mesas now returns 12
    print("\nVerifying GET /mesas now returns 12...")
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        if len(mesas) == 12:
            log_pass("GET /mesas after configurar", f"Confirmed {len(mesas)} mesas")
        else:
            log_fail("GET /mesas after configurar", f"Expected 12, got {len(mesas)}")
    else:
        log_fail("GET /mesas after configurar", f"Status {resp.status_code}: {resp.text}")
    
    # 1.4 PUT /mesas/:id - change status to 'reservada'
    print("\nTesting PUT /mesas/:id (change status to reservada)...")
    mesa_livre = next((m for m in tenant["mesas"] if m["status"] == "livre"), None)
    if mesa_livre:
        update_data = {"status": "reservada"}
        resp = requests.put(f"{BASE_URL}/mesas/{mesa_livre['id']}", json=update_data, headers=headers)
        if resp.status_code == 200:
            mesa_updated = resp.json()
            if mesa_updated.get("status") == "reservada":
                log_pass("PUT /mesas/:id updates status", f"Mesa {mesa_livre['numero']} now reservada")
                tenant["mesa_reservada_id"] = mesa_livre["id"]
            else:
                log_fail("PUT /mesas/:id status not updated", str(mesa_updated))
        else:
            log_fail("PUT /mesas/:id", f"Status {resp.status_code}: {resp.text}")
    else:
        log_fail("PUT /mesas/:id", "No mesa livre found for test")
    
    print_section("2. COMANDAS - FULL FLOW")
    
    # Get a cliente for the comanda
    print("Getting clientes for comanda...")
    resp = requests.get(f"{BASE_URL}/clientes", headers=headers)
    if resp.status_code == 200:
        clientes = resp.json()
        if len(clientes) > 0:
            tenant["cliente"] = clientes[0]
            print(f"   Using cliente: {tenant['cliente']['nome']}")
        else:
            log_fail("GET /clientes", "No clientes in seed", critical=True)
    else:
        log_fail("GET /clientes", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # Get produtos for adding to comanda
    print("\nGetting produtos for comanda...")
    resp = requests.get(f"{BASE_URL}/produtos", headers=headers)
    if resp.status_code == 200:
        produtos = resp.json()
        if len(produtos) >= 2:
            tenant["produtos"] = produtos[:3]  # Get first 3 produtos
            print(f"   Using {len(tenant['produtos'])} produtos")
        else:
            log_fail("GET /produtos", "Not enough produtos in seed", critical=True)
    else:
        log_fail("GET /produtos", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 2.1 POST /mesas/:id/abrir - open comanda on a free mesa
    print("\nTesting POST /mesas/:id/abrir (open comanda)...")
    mesa_livre = next((m for m in tenant["mesas"] if m["status"] == "livre" and m["numero"] not in [2]), None)
    if mesa_livre and "cliente" in tenant:
        abrir_data = {
            "cliente_id": tenant["cliente"]["id"],
            "pessoas": 4
        }
        resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", json=abrir_data, headers=headers)
        if resp.status_code == 201:
            comanda = resp.json()
            required_fields = ["id", "mesa_id", "cliente_id", "status", "subtotal", "total", "pago", "restante"]
            if all(f in comanda for f in required_fields):
                if comanda["status"] == "aberta" and comanda["subtotal"] == 0 and comanda["total"] == 0:
                    log_pass("POST /mesas/:id/abrir creates comanda", 
                            f"Comanda ID: {comanda['id']}, Status: {comanda['status']}")
                    tenant["comanda_id"] = comanda["id"]
                    tenant["comanda_mesa_id"] = mesa_livre["id"]
                    tenant["comanda_mesa_numero"] = mesa_livre["numero"]
                else:
                    log_fail("POST /mesas/:id/abrir comanda state", 
                            f"Expected status=aberta, subtotal=0, total=0, got: {comanda}", critical=True)
            else:
                log_fail("POST /mesas/:id/abrir missing fields", str(comanda), critical=True)
        else:
            log_fail("POST /mesas/:id/abrir", f"Status {resp.status_code}: {resp.text}", critical=True)
    else:
        log_fail("POST /mesas/:id/abrir", "No mesa livre or cliente available", critical=True)
    
    # Verify mesa is now ocupada
    print("\nVerifying mesa is now ocupada...")
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        mesa = next((m for m in mesas if m["id"] == tenant["comanda_mesa_id"]), None)
        if mesa and mesa["status"] == "ocupada" and mesa.get("comanda_id") == tenant["comanda_id"]:
            log_pass("Mesa status updated to ocupada", f"Mesa {mesa['numero']} now ocupada with comanda")
        else:
            log_fail("Mesa status not updated", str(mesa))
    
    # 2.2 POST /comandas/:id/itens - add first item
    print("\nTesting POST /comandas/:id/itens (add item 1)...")
    if "comanda_id" in tenant and "produtos" in tenant:
        produto1 = tenant["produtos"][0]
        item_data = {
            "produto_id": produto1["id"],
            "quantidade": 2
        }
        resp = requests.post(f"{BASE_URL}/comandas/{tenant['comanda_id']}/itens", json=item_data, headers=headers)
        if resp.status_code == 201:
            comanda = resp.json()
            expected_subtotal = produto1["preco"] * 2
            if len(comanda.get("itens", [])) == 1 and abs(comanda["subtotal"] - expected_subtotal) < 0.01:
                log_pass("POST /comandas/:id/itens adds item", 
                        f"Subtotal: {comanda['subtotal']} (expected ~{expected_subtotal})")
                tenant["item1_id"] = comanda["itens"][0]["id"]
            else:
                log_fail("POST /comandas/:id/itens calculation", 
                        f"Expected subtotal ~{expected_subtotal}, got {comanda.get('subtotal')}", critical=True)
        else:
            log_fail("POST /comandas/:id/itens", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 2.3 POST /comandas/:id/itens - add second item
    print("\nTesting POST /comandas/:id/itens (add item 2)...")
    if "comanda_id" in tenant and "produtos" in tenant:
        produto2 = tenant["produtos"][1]
        item_data = {
            "produto_id": produto2["id"],
            "quantidade": 1
        }
        resp = requests.post(f"{BASE_URL}/comandas/{tenant['comanda_id']}/itens", json=item_data, headers=headers)
        if resp.status_code == 201:
            comanda = resp.json()
            if len(comanda.get("itens", [])) == 2:
                log_pass("POST /comandas/:id/itens adds second item", f"Now {len(comanda['itens'])} items")
                tenant["item2_id"] = comanda["itens"][1]["id"]
                tenant["subtotal_before_changes"] = comanda["subtotal"]
            else:
                log_fail("POST /comandas/:id/itens item count", f"Expected 2 items, got {len(comanda.get('itens', []))}")
        else:
            log_fail("POST /comandas/:id/itens (item 2)", f"Status {resp.status_code}: {resp.text}")
    
    # 2.4 PUT /comandas/:id/itens/:itemId - update quantity
    print("\nTesting PUT /comandas/:id/itens/:itemId (update quantity)...")
    if "comanda_id" in tenant and "item1_id" in tenant:
        update_data = {"quantidade": 3}
        resp = requests.put(f"{BASE_URL}/comandas/{tenant['comanda_id']}/itens/{tenant['item1_id']}", 
                           json=update_data, headers=headers)
        if resp.status_code == 200:
            comanda = resp.json()
            item = next((i for i in comanda.get("itens", []) if i["id"] == tenant["item1_id"]), None)
            if item and item["quantidade"] == 3:
                log_pass("PUT /comandas/:id/itens/:itemId updates quantity", 
                        f"Item quantity now {item['quantidade']}")
                tenant["subtotal_after_update"] = comanda["subtotal"]
            else:
                log_fail("PUT /comandas/:id/itens/:itemId quantity not updated", str(item))
        else:
            log_fail("PUT /comandas/:id/itens/:itemId", f"Status {resp.status_code}: {resp.text}")
    
    # 2.5 DELETE /comandas/:id/itens/:itemId - remove item
    print("\nTesting DELETE /comandas/:id/itens/:itemId (remove item)...")
    if "comanda_id" in tenant and "item2_id" in tenant:
        resp = requests.delete(f"{BASE_URL}/comandas/{tenant['comanda_id']}/itens/{tenant['item2_id']}", 
                              headers=headers)
        if resp.status_code == 200:
            comanda = resp.json()
            if len(comanda.get("itens", [])) == 1:
                log_pass("DELETE /comandas/:id/itens/:itemId removes item", 
                        f"Now {len(comanda['itens'])} item(s)")
                tenant["subtotal_after_delete"] = comanda["subtotal"]
            else:
                log_fail("DELETE /comandas/:id/itens/:itemId count", 
                        f"Expected 1 item, got {len(comanda.get('itens', []))}")
        else:
            log_fail("DELETE /comandas/:id/itens/:itemId", f"Status {resp.status_code}: {resp.text}")
    
    # 2.6 PUT /comandas/:id - apply desconto and taxa_servico
    print("\nTesting PUT /comandas/:id (apply desconto and taxa)...")
    if "comanda_id" in tenant:
        update_data = {
            "desconto": 10,
            "desconto_tipo": "valor",
            "taxa_servico_percent": 10
        }
        resp = requests.put(f"{BASE_URL}/comandas/{tenant['comanda_id']}", json=update_data, headers=headers)
        if resp.status_code == 200:
            comanda = resp.json()
            # Verify calculation: total = (subtotal - desconto) * (1 + taxa/100)
            subtotal = comanda.get("subtotal", 0)
            desconto_valor = comanda.get("desconto_valor", 0)
            taxa_valor = comanda.get("taxa_valor", 0)
            total = comanda.get("total", 0)
            
            expected_desconto = 10
            base = subtotal - expected_desconto
            expected_taxa = base * 0.10
            expected_total = base + expected_taxa
            
            if (abs(desconto_valor - expected_desconto) < 0.01 and 
                abs(taxa_valor - expected_taxa) < 0.01 and 
                abs(total - expected_total) < 0.01):
                log_pass("PUT /comandas/:id applies desconto and taxa correctly", 
                        f"Subtotal: {subtotal}, Desconto: {desconto_valor}, Taxa: {taxa_valor}, Total: {total}")
                tenant["comanda_total"] = total
            else:
                log_fail("PUT /comandas/:id calculation error", 
                        f"Expected total ~{expected_total}, got {total}. Subtotal: {subtotal}, Desconto: {desconto_valor}, Taxa: {taxa_valor}", 
                        critical=True)
        else:
            log_fail("PUT /comandas/:id", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 2.7 POST /comandas/:id/pagamentos - register partial payment
    print("\nTesting POST /comandas/:id/pagamentos (partial payment)...")
    if "comanda_id" in tenant and "comanda_total" in tenant:
        partial_amount = round(tenant["comanda_total"] / 2, 2)
        pagamento_data = {
            "metodo": "dinheiro",
            "valor": partial_amount
        }
        resp = requests.post(f"{BASE_URL}/comandas/{tenant['comanda_id']}/pagamentos", 
                            json=pagamento_data, headers=headers)
        if resp.status_code == 201:
            comanda = resp.json()
            pago = comanda.get("pago", 0)
            restante = comanda.get("restante", 0)
            
            if abs(pago - partial_amount) < 0.01 and abs(restante - (tenant["comanda_total"] - partial_amount)) < 0.01:
                log_pass("POST /comandas/:id/pagamentos registers partial payment", 
                        f"Pago: {pago}, Restante: {restante}")
                tenant["comanda_pago"] = pago
                tenant["comanda_restante"] = restante
            else:
                log_fail("POST /comandas/:id/pagamentos calculation", 
                        f"Expected pago ~{partial_amount}, restante ~{tenant['comanda_total'] - partial_amount}, got pago: {pago}, restante: {restante}", 
                        critical=True)
        else:
            log_fail("POST /comandas/:id/pagamentos", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 2.8 POST /comandas/:id/pagamentos - register second payment to complete
    print("\nTesting POST /comandas/:id/pagamentos (complete payment)...")
    if "comanda_id" in tenant and "comanda_restante" in tenant:
        pagamento_data = {
            "metodo": "cartao_credito",
            "valor": tenant["comanda_restante"]
        }
        resp = requests.post(f"{BASE_URL}/comandas/{tenant['comanda_id']}/pagamentos", 
                            json=pagamento_data, headers=headers)
        if resp.status_code == 201:
            comanda = resp.json()
            pago = comanda.get("pago", 0)
            restante = comanda.get("restante", 0)
            
            if abs(pago - tenant["comanda_total"]) < 0.01 and abs(restante) < 0.01:
                log_pass("POST /comandas/:id/pagamentos completes payment", 
                        f"Pago: {pago}, Restante: {restante}")
            else:
                log_fail("POST /comandas/:id/pagamentos completion", 
                        f"Expected pago ~{tenant['comanda_total']}, restante ~0, got pago: {pago}, restante: {restante}")
        else:
            log_fail("POST /comandas/:id/pagamentos (complete)", f"Status {resp.status_code}: {resp.text}")
    
    # 2.9 POST /comandas/:id/fechar - close comanda (should fail if restante > 0)
    print("\nTesting POST /comandas/:id/fechar (close comanda)...")
    if "comanda_id" in tenant:
        # Get initial transacoes count
        resp_trans = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers)
        initial_trans_count = len(resp_trans.json()) if resp_trans.status_code == 200 else 0
        
        resp = requests.post(f"{BASE_URL}/comandas/{tenant['comanda_id']}/fechar", headers=headers)
        if resp.status_code == 200:
            result = resp.json()
            if "ok" in result and "pedido_numero" in result and "total" in result:
                log_pass("POST /comandas/:id/fechar closes comanda", 
                        f"Pedido #{result['pedido_numero']}, Total: {result['total']}")
                tenant["pedido_numero"] = result["pedido_numero"]
                
                # Verify transacao receita was created
                print("\n   Verifying transacao receita was created...")
                resp_trans = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers)
                if resp_trans.status_code == 200:
                    transacoes = resp_trans.json()
                    new_trans_count = len(transacoes)
                    if new_trans_count > initial_trans_count:
                        log_pass("Transacao receita created after fechar", 
                                f"Transacoes count increased from {initial_trans_count} to {new_trans_count}")
                    else:
                        log_fail("Transacao receita NOT created", 
                                f"Count unchanged: {new_trans_count}", critical=True)
                
                # Verify mesa is now livre
                print("\n   Verifying mesa is now livre...")
                resp_mesas = requests.get(f"{BASE_URL}/mesas", headers=headers)
                if resp_mesas.status_code == 200:
                    mesas = resp_mesas.json()
                    mesa = next((m for m in mesas if m["id"] == tenant["comanda_mesa_id"]), None)
                    if mesa and mesa["status"] == "livre" and mesa.get("comanda_id") is None:
                        log_pass("Mesa released after fechar", 
                                f"Mesa {mesa['numero']} now livre")
                    else:
                        log_fail("Mesa NOT released after fechar", str(mesa), critical=True)
                
                # Verify comanda status is fechada
                print("\n   Verifying comanda status is fechada...")
                resp_comanda = requests.get(f"{BASE_URL}/comandas/{tenant['comanda_id']}", headers=headers)
                if resp_comanda.status_code == 200:
                    comanda = resp_comanda.json()
                    if comanda.get("status") == "fechada":
                        log_pass("Comanda status updated to fechada")
                    else:
                        log_fail("Comanda status NOT fechada", f"Status: {comanda.get('status')}")
            else:
                log_fail("POST /comandas/:id/fechar response", str(result), critical=True)
        else:
            log_fail("POST /comandas/:id/fechar", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # 2.10 TRANSFERIR - open another comanda and transfer to another mesa
    print("\nTesting POST /comandas/:id/transferir (transfer comanda)...")
    # Find two free mesas
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        mesas_livres = [m for m in mesas if m["status"] == "livre"]
        if len(mesas_livres) >= 2:
            mesa_origem = mesas_livres[0]
            mesa_destino = mesas_livres[1]
            
            # Open comanda on origem
            abrir_data = {
                "cliente_id": tenant["cliente"]["id"],
                "pessoas": 2
            }
            resp = requests.post(f"{BASE_URL}/mesas/{mesa_origem['id']}/abrir", json=abrir_data, headers=headers)
            if resp.status_code == 201:
                comanda_transfer = resp.json()
                comanda_transfer_id = comanda_transfer["id"]
                
                # Transfer to destino
                transfer_data = {"mesa_id": mesa_destino["id"]}
                resp = requests.post(f"{BASE_URL}/comandas/{comanda_transfer_id}/transferir", 
                                    json=transfer_data, headers=headers)
                if resp.status_code == 200:
                    comanda_updated = resp.json()
                    if comanda_updated.get("mesa_id") == mesa_destino["id"]:
                        log_pass("POST /comandas/:id/transferir transfers comanda", 
                                f"From Mesa {mesa_origem['numero']} to Mesa {mesa_destino['numero']}")
                        
                        # Verify origem is livre and destino is ocupada
                        resp_mesas = requests.get(f"{BASE_URL}/mesas", headers=headers)
                        if resp_mesas.status_code == 200:
                            mesas_after = resp_mesas.json()
                            origem_after = next((m for m in mesas_after if m["id"] == mesa_origem["id"]), None)
                            destino_after = next((m for m in mesas_after if m["id"] == mesa_destino["id"]), None)
                            
                            if (origem_after and origem_after["status"] == "livre" and 
                                destino_after and destino_after["status"] == "ocupada" and 
                                destino_after.get("comanda_id") == comanda_transfer_id):
                                log_pass("Mesas updated after transfer", 
                                        f"Origem livre, Destino ocupada with comanda")
                            else:
                                log_fail("Mesas NOT updated after transfer", 
                                        f"Origem: {origem_after}, Destino: {destino_after}")
                    else:
                        log_fail("POST /comandas/:id/transferir mesa_id not updated", str(comanda_updated))
                else:
                    log_fail("POST /comandas/:id/transferir", f"Status {resp.status_code}: {resp.text}")
            else:
                log_fail("POST /mesas/:id/abrir for transfer test", f"Status {resp.status_code}")
        else:
            log_fail("POST /comandas/:id/transferir", "Not enough free mesas for test")
    
    print_section("3. MERCADO PAGO (NO MOCKING)")
    
    # 3.1 GET /integracoes - verify mercadopago exists
    print("Testing GET /integracoes (verify mercadopago)...")
    resp = requests.get(f"{BASE_URL}/integracoes", headers=headers)
    if resp.status_code == 200:
        integracoes = resp.json()
        if "mercadopago" in integracoes:
            mp = integracoes["mercadopago"]
            if "config" in mp and "hasAccessToken" in mp["config"]:
                log_pass("GET /integracoes includes mercadopago", 
                        f"hasAccessToken: {mp['config']['hasAccessToken']}")
            else:
                log_fail("GET /integracoes mercadopago structure", str(mp))
        else:
            log_fail("GET /integracoes missing mercadopago", str(integracoes))
        
        # Verify gateways and methods are present
        if "gateways" in integracoes and "methods" in integracoes:
            log_pass("GET /integracoes includes gateways and methods")
        else:
            log_fail("GET /integracoes missing gateways/methods", str(integracoes))
    else:
        log_fail("GET /integracoes", f"Status {resp.status_code}: {resp.text}")
    
    # 3.2 POST /comandas/:id/pix WITHOUT credentials - should return 400
    print("\nTesting POST /comandas/:id/pix WITHOUT credentials (should fail)...")
    # Open a new comanda for pix test
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        mesa_livre = next((m for m in mesas if m["status"] == "livre"), None)
        if mesa_livre:
            abrir_data = {"cliente_id": tenant["cliente"]["id"], "pessoas": 2}
            resp = requests.post(f"{BASE_URL}/mesas/{mesa_livre['id']}/abrir", json=abrir_data, headers=headers)
            if resp.status_code == 201:
                comanda_pix = resp.json()
                comanda_pix_id = comanda_pix["id"]
                
                # Try to create pix without credentials
                resp = requests.post(f"{BASE_URL}/comandas/{comanda_pix_id}/pix", json={}, headers=headers)
                if resp.status_code == 400:
                    error_msg = resp.json().get("error", "")
                    if "Mercado Pago nao configurado" in error_msg:
                        log_pass("POST /comandas/:id/pix without credentials returns 400", 
                                f"Error: {error_msg}")
                    else:
                        log_fail("POST /comandas/:id/pix error message", 
                                f"Expected 'Mercado Pago nao configurado', got: {error_msg}")
                else:
                    log_fail("POST /comandas/:id/pix without credentials", 
                            f"Expected 400, got {resp.status_code}: {resp.text}", critical=True)
    
    # 3.3 PUT /integracoes/mercadopago - configure without accessToken
    print("\nTesting PUT /integracoes/mercadopago (without accessToken)...")
    mp_config = {"mode": "sandbox"}
    resp = requests.put(f"{BASE_URL}/integracoes/mercadopago", json=mp_config, headers=headers)
    if resp.status_code == 200:
        result = resp.json()
        if result.get("status") == "nao_configurado":
            log_pass("PUT /integracoes/mercadopago without token", 
                    f"Status: {result['status']}")
        else:
            log_fail("PUT /integracoes/mercadopago status", 
                    f"Expected nao_configurado, got {result.get('status')}")
    else:
        log_fail("PUT /integracoes/mercadopago", f"Status {resp.status_code}: {resp.text}")
    
    # 3.4 PUT /integracoes/mercadopago - configure with fake accessToken
    print("\nTesting PUT /integracoes/mercadopago (with fake accessToken)...")
    mp_config = {"mode": "sandbox", "accessToken": "TEST-fake-token-123"}
    resp = requests.put(f"{BASE_URL}/integracoes/mercadopago", json=mp_config, headers=headers)
    if resp.status_code == 200:
        result = resp.json()
        if result.get("status") == "configurado" and result.get("hasAccessToken") == True:
            log_pass("PUT /integracoes/mercadopago with token", 
                    f"Status: {result['status']}, hasAccessToken: {result['hasAccessToken']}")
        else:
            log_fail("PUT /integracoes/mercadopago with token", str(result))
    else:
        log_fail("PUT /integracoes/mercadopago with token", f"Status {resp.status_code}: {resp.text}")
    
    # 3.5 GET /integracoes - verify accessToken is NOT exposed
    print("\nTesting GET /integracoes (verify accessToken NOT exposed)...")
    resp = requests.get(f"{BASE_URL}/integracoes", headers=headers)
    if resp.status_code == 200:
        integracoes = resp.json()
        mp = integracoes.get("mercadopago", {})
        config = mp.get("config", {})
        if "accessToken" not in config and config.get("hasAccessToken") == True:
            log_pass("GET /integracoes does NOT expose accessToken", 
                    "Only hasAccessToken flag present")
        else:
            log_fail("GET /integracoes exposes accessToken", 
                    f"Config: {config}", critical=True)
    else:
        log_fail("GET /integracoes", f"Status {resp.status_code}: {resp.text}")
    
    # 3.6 POST /pagamentos/webhook/mercadopago - without params (should fail 400)
    print("\nTesting POST /pagamentos/webhook/mercadopago (without params)...")
    resp = requests.post(f"{BASE_URL}/pagamentos/webhook/mercadopago", json={})
    if resp.status_code == 400:
        log_pass("POST webhook without params returns 400")
    else:
        log_fail("POST webhook without params", f"Expected 400, got {resp.status_code}")
    
    # 3.7 POST /pagamentos/webhook/mercadopago - with params but without signature (should fail 401)
    print("\nTesting POST webhook with params but without signature...")
    webhook_url = f"{BASE_URL}/pagamentos/webhook/mercadopago?tenant={tenant['empresa_id']}&data.id=123"
    resp = requests.post(webhook_url, json={})
    if resp.status_code in [401, 404]:
        log_pass(f"POST webhook without signature returns {resp.status_code}", 
                "Correctly rejects unsigned webhook")
    else:
        log_fail("POST webhook without signature", 
                f"Expected 401 or 404, got {resp.status_code}: {resp.text}")
    
    print_section("4. EMPRESA BRANDING/CONFIG")
    
    # 4.1 GET /empresa - get current config
    print("Testing GET /empresa (get current config)...")
    resp = requests.get(f"{BASE_URL}/empresa", headers=headers)
    if resp.status_code == 200:
        empresa_before = resp.json()
        tenant["empresa_before"] = empresa_before
        log_pass("GET /empresa returns current config")
    else:
        log_fail("GET /empresa", f"Status {resp.status_code}: {resp.text}")
    
    # 4.2 PUT /empresa - update with branding and config
    print("\nTesting PUT /empresa (update branding and config)...")
    update_data = {
        "nome_comercial": "Cantina Bella Vista",
        "cnpj": "12.345.678/0001-90",
        "whatsapp": "5511999887766",
        "config": {
            "appearance": {
                "cor_principal": "#ff0000",
                "tema": "light"
            },
            "pagamentos": {
                "metodos": {
                    "dinheiro": True,
                    "pix": False
                }
            }
        }
    }
    resp = requests.put(f"{BASE_URL}/empresa", json=update_data, headers=headers)
    if resp.status_code == 200:
        empresa_after = resp.json()
        
        # Verify fields were updated
        if (empresa_after.get("nome_comercial") == "Cantina Bella Vista" and
            empresa_after.get("cnpj") == "12.345.678/0001-90" and
            empresa_after.get("whatsapp") == "5511999887766"):
            log_pass("PUT /empresa updates basic fields")
        else:
            log_fail("PUT /empresa basic fields", str(empresa_after))
        
        # Verify config merge (appearance)
        config = empresa_after.get("config", {})
        appearance = config.get("appearance", {})
        if (appearance.get("cor_principal") == "#ff0000" and 
            appearance.get("tema") == "light"):
            log_pass("PUT /empresa merges config.appearance", 
                    f"cor_principal: {appearance.get('cor_principal')}, tema: {appearance.get('tema')}")
        else:
            log_fail("PUT /empresa config.appearance merge", str(appearance))
        
        # Verify config merge (pagamentos)
        pagamentos = config.get("pagamentos", {})
        metodos = pagamentos.get("metodos", {})
        if metodos.get("dinheiro") == True and metodos.get("pix") == False:
            log_pass("PUT /empresa merges config.pagamentos.metodos")
        else:
            log_fail("PUT /empresa config.pagamentos merge", str(metodos))
        
        # Verify feature_flags were preserved (not overwritten)
        feature_flags = config.get("feature_flags", {})
        if "mesas" in feature_flags and "comandas" in feature_flags:
            log_pass("PUT /empresa preserves feature_flags", 
                    f"mesas: {feature_flags.get('mesas')}, comandas: {feature_flags.get('comandas')}")
        else:
            log_fail("PUT /empresa feature_flags NOT preserved", str(feature_flags), critical=True)
    else:
        log_fail("PUT /empresa", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    print_section("5. REGRESSION TESTS")
    
    # 5.1 GET /dashboard/metrics
    print("Testing GET /dashboard/metrics (regression)...")
    resp = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers)
    if resp.status_code == 200:
        metrics = resp.json()
        required_fields = ["faturamentoHoje", "pedidosHoje", "ticketMedio", "totalClientes", 
                          "totalProdutos", "serie", "topProdutos", "recentes", "porStatus"]
        if all(f in metrics for f in required_fields):
            log_pass("GET /dashboard/metrics still working")
        else:
            log_fail("GET /dashboard/metrics regression", f"Missing fields")
    else:
        log_fail("GET /dashboard/metrics regression", f"Status {resp.status_code}: {resp.text}")
    
    # 5.2 GET /pedidos
    print("\nTesting GET /pedidos (regression)...")
    resp = requests.get(f"{BASE_URL}/pedidos", headers=headers)
    if resp.status_code == 200:
        pedidos = resp.json()
        if len(pedidos) > 0:
            log_pass("GET /pedidos still working", f"Found {len(pedidos)} pedidos")
        else:
            log_fail("GET /pedidos regression", "No pedidos found")
    else:
        log_fail("GET /pedidos regression", f"Status {resp.status_code}: {resp.text}")
    
    # 5.3 POST /pedidos
    print("\nTesting POST /pedidos (regression)...")
    if "produtos" in tenant and "cliente" in tenant:
        produto = tenant["produtos"][0]
        pedido_data = {
            "cliente_id": tenant["cliente"]["id"],
            "tipo": "delivery",
            "pagamento": "pix",
            "itens": [
                {
                    "produto_id": produto["id"],
                    "nome": produto["nome"],
                    "preco": produto["preco"],
                    "quantidade": 1
                }
            ]
        }
        resp = requests.post(f"{BASE_URL}/pedidos", json=pedido_data, headers=headers)
        if resp.status_code == 201:
            pedido = resp.json()
            if "id" in pedido and "numero" in pedido:
                log_pass("POST /pedidos still working", f"Created pedido #{pedido['numero']}")
            else:
                log_fail("POST /pedidos regression response", str(pedido))
        else:
            log_fail("POST /pedidos regression", f"Status {resp.status_code}: {resp.text}")
    
    # 5.4 GET /auditoria
    print("\nTesting GET /auditoria (regression)...")
    resp = requests.get(f"{BASE_URL}/auditoria", headers=headers)
    if resp.status_code == 200:
        auditoria = resp.json()
        if len(auditoria) > 0:
            # Check for new actions (abrir, add_item, pagamento, fechar, transferir)
            acoes = set(a.get("acao") for a in auditoria)
            new_acoes = ["abrir", "add_item", "pagamento", "fechar", "transferir"]
            found_new = [a for a in new_acoes if a in acoes]
            if len(found_new) > 0:
                log_pass("GET /auditoria includes new actions", 
                        f"Found: {', '.join(found_new)}")
            else:
                log_pass("GET /auditoria still working", f"Found {len(auditoria)} records")
        else:
            log_fail("GET /auditoria regression", "No audit records")
    else:
        log_fail("GET /auditoria regression", f"Status {resp.status_code}: {resp.text}")

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
