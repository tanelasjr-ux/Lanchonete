#!/usr/bin/env python3
"""
Restaurant OS v3 - Backend API Test Suite
Tests NEW v3 modules:
- WhatsApp Webhook (pre-auth)
- Conversas (Central de Atendimento)
- Mensagens (envio via Evolution - must return 400 without config)
- Relatorio Financeiro (real data with filters)
- Regression: ENTREGUE status creates receita, multitenancy isolation
"""

import requests
import json
import random
import string
import os
from datetime import datetime, timedelta

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
    print_section("SETUP: Register Tenant A")
    
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
        tenant_a["token"] = data["token"]
        tenant_a["usuario"] = data["usuario"]
        tenant_a["empresa"] = data["empresa"]
        tenant_a["empresa_id"] = data["empresa"]["id"]
        tenant_a["email"] = tenant_a_email
        tenant_a["senha"] = "senha_segura_123"
        log_pass(f"Setup Tenant A - empresa_id: {tenant_a['empresa_id']}")
        print(f"   Token: {tenant_a['token'][:20]}...")
    else:
        log_fail("Setup Tenant A", f"Status {resp.status_code}: {resp.text}", critical=True)
        raise Exception("Cannot proceed without tenant setup")

    # ========================================================================
    # A) WEBHOOK WHATSAPP (pre-auth, no token required)
    # ========================================================================
    print_section("A) WEBHOOK WHATSAPP (pre-auth)")
    
    # A.1 - POST webhook with Evolution messages.upsert format - should create cliente + conversa + mensagem
    print("A.1 - POST /whatsapp/webhook?tenant=<empresa_id> - Create new conversa...")
    webhook_body = {
        "event": "messages.upsert",
        "data": {
            "key": {
                "remoteJid": "5511977776666@s.whatsapp.net",
                "fromMe": False,
                "id": "ABC123"
            },
            "pushName": "Maria Teste",
            "message": {
                "conversation": "Ola, gostaria de fazer um pedido"
            },
            "messageType": "conversation"
        }
    }
    
    resp = requests.post(f"{BASE_URL}/whatsapp/webhook?tenant={tenant_a['empresa_id']}", json=webhook_body)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("ok") == True:
            log_pass("Webhook - Create new conversa returns 200 {ok:true}")
        else:
            log_fail("Webhook - Create new conversa", f"Expected ok:true, got {data}")
    else:
        log_fail("Webhook - Create new conversa", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # A.2 - Verify conversa was created (should have 3 total: 2 from seed + 1 from webhook)
    print("\nA.2 - GET /conversas - Verify conversa created (should have 3 total)...")
    headers = {"Authorization": f"Bearer {tenant_a['token']}"}
    resp = requests.get(f"{BASE_URL}/conversas", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        if len(conversas) >= 3:
            # Find the webhook-created conversa
            webhook_conv = None
            for c in conversas:
                if c.get("contato_numero") == "5511977776666":
                    webhook_conv = c
                    break
            
            if webhook_conv:
                if (webhook_conv.get("status") == "AGUARDANDO_EQUIPE" and 
                    webhook_conv.get("nao_lidas", 0) >= 1 and
                    "Maria" in webhook_conv.get("contato_nome", "")):
                    log_pass("Webhook - Conversa created with correct status (AGUARDANDO_EQUIPE), nao_lidas>=1, contato_nome")
                    tenant_a["webhook_conversa_id"] = webhook_conv["id"]
                else:
                    log_fail("Webhook - Conversa fields", f"Expected AGUARDANDO_EQUIPE with nao_lidas>=1, got {webhook_conv}")
            else:
                log_fail("Webhook - Conversa not found", f"Number 5511977776666 not in conversas list", critical=True)
        else:
            log_fail("Webhook - Conversa count", f"Expected >=3 conversas (2 seed + 1 webhook), got {len(conversas)}", critical=True)
    else:
        log_fail("Webhook - GET conversas", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # A.3 - Verify mensagem was created
    print("\nA.3 - GET /conversas/:id/mensagens - Verify mensagem created...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/mensagens", headers=headers)
        if resp.status_code == 200:
            mensagens = resp.json()
            if len(mensagens) >= 1:
                msg = mensagens[0]
                if (msg.get("direcao") == "in" and 
                    msg.get("tipo") == "text" and
                    "Ola, gostaria de fazer um pedido" in msg.get("texto", "")):
                    log_pass("Webhook - Mensagem created with correct direcao (in), tipo (text), texto")
                else:
                    log_fail("Webhook - Mensagem fields", f"Expected direcao:in, tipo:text, got {msg}")
            else:
                log_fail("Webhook - Mensagem count", f"Expected >=1 mensagem, got {len(mensagens)}")
        else:
            log_fail("Webhook - GET mensagens", f"Status {resp.status_code}: {resp.text}")
    
    # A.4 - Send ANOTHER message from SAME number - should reuse conversa (not duplicate)
    print("\nA.4 - POST /whatsapp/webhook - Send another message from same number (should reuse conversa)...")
    webhook_body2 = {
        "event": "messages.upsert",
        "data": {
            "key": {
                "remoteJid": "5511977776666@s.whatsapp.net",
                "fromMe": False,
                "id": "ABC456"
            },
            "pushName": "Maria Teste",
            "message": {
                "conversation": "Pode me enviar o cardapio?"
            },
            "messageType": "conversation"
        }
    }
    
    resp = requests.post(f"{BASE_URL}/whatsapp/webhook?tenant={tenant_a['empresa_id']}", json=webhook_body2)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("ok") == True:
            log_pass("Webhook - Second message returns 200 {ok:true}")
        else:
            log_fail("Webhook - Second message", f"Expected ok:true, got {data}")
    else:
        log_fail("Webhook - Second message", f"Status {resp.status_code}: {resp.text}")
    
    # A.5 - Verify conversa was reused (still 3 total, not 4)
    print("\nA.5 - GET /conversas - Verify conversa reused (still 3 total)...")
    resp = requests.get(f"{BASE_URL}/conversas", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        if len(conversas) == 3:
            log_pass("Webhook - Conversa reused (still 3 total, not duplicated)")
        else:
            log_fail("Webhook - Conversa duplicated", f"Expected 3 conversas, got {len(conversas)}")
        
        # Verify nao_lidas incremented
        webhook_conv = next((c for c in conversas if c.get("contato_numero") == "5511977776666"), None)
        if webhook_conv and webhook_conv.get("nao_lidas", 0) >= 2:
            log_pass("Webhook - nao_lidas incremented (>=2)")
        else:
            log_fail("Webhook - nao_lidas not incremented", f"Expected >=2, got {webhook_conv.get('nao_lidas', 0) if webhook_conv else 'N/A'}")
    else:
        log_fail("Webhook - GET conversas", f"Status {resp.status_code}: {resp.text}")
    
    # A.6 - Verify mensagens count increased (should have 2 now)
    print("\nA.6 - GET /conversas/:id/mensagens - Verify 2 mensagens...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/mensagens", headers=headers)
        if resp.status_code == 200:
            mensagens = resp.json()
            if len(mensagens) >= 2:
                log_pass("Webhook - Second mensagem created (total >=2)")
            else:
                log_fail("Webhook - Mensagem count", f"Expected >=2 mensagens, got {len(mensagens)}")
        else:
            log_fail("Webhook - GET mensagens", f"Status {resp.status_code}: {resp.text}")
    
    # A.7 - Send message with fromMe:true - should be IGNORED
    print("\nA.7 - POST /whatsapp/webhook with fromMe:true - Should be ignored...")
    webhook_body3 = {
        "event": "messages.upsert",
        "data": {
            "key": {
                "remoteJid": "5511977776666@s.whatsapp.net",
                "fromMe": True,
                "id": "ABC789"
            },
            "pushName": "Maria Teste",
            "message": {
                "conversation": "Esta mensagem deve ser ignorada"
            },
            "messageType": "conversation"
        }
    }
    
    resp = requests.post(f"{BASE_URL}/whatsapp/webhook?tenant={tenant_a['empresa_id']}", json=webhook_body3)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("ok") == True and data.get("ignored") == "from_me":
            log_pass("Webhook - fromMe:true ignored correctly")
        else:
            log_fail("Webhook - fromMe:true not ignored", f"Expected ignored:from_me, got {data}")
    else:
        log_fail("Webhook - fromMe:true", f"Status {resp.status_code}: {resp.text}")
    
    # A.8 - Verify mensagens count unchanged (still 2)
    print("\nA.8 - GET /conversas/:id/mensagens - Verify mensagens still 2 (fromMe ignored)...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/mensagens", headers=headers)
        if resp.status_code == 200:
            mensagens = resp.json()
            if len(mensagens) == 2:
                log_pass("Webhook - fromMe message not created (still 2 mensagens)")
            else:
                log_fail("Webhook - fromMe message created", f"Expected 2 mensagens, got {len(mensagens)}")
        else:
            log_fail("Webhook - GET mensagens", f"Status {resp.status_code}: {resp.text}")
    
    # A.9 - Send webhook without tenant param - should return 200 ignored
    print("\nA.9 - POST /whatsapp/webhook without tenant - Should return 200 ignored...")
    resp = requests.post(f"{BASE_URL}/whatsapp/webhook", json=webhook_body)
    if resp.status_code == 200:
        data = resp.json()
        if data.get("ok") == True and data.get("ignored") == "no-tenant":
            log_pass("Webhook - Without tenant returns 200 ignored")
        else:
            log_fail("Webhook - Without tenant", f"Expected ignored:no-tenant, got {data}")
    else:
        log_fail("Webhook - Without tenant", f"Status {resp.status_code}: {resp.text}")

    # ========================================================================
    # B) CONVERSAS (auth required, permission atendimento - OWNER has)
    # ========================================================================
    print_section("B) CONVERSAS (auth required)")
    
    # B.1 - GET /conversas - List all (should have 3: 2 seed + 1 webhook)
    print("B.1 - GET /conversas - List all...")
    resp = requests.get(f"{BASE_URL}/conversas", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        if len(conversas) >= 3:
            # Verify structure
            conv = conversas[0]
            required_fields = ["id", "contato_nome", "contato_numero", "status", "nao_lidas", "ultima_mensagem", "pedido", "tem_pedido"]
            missing = [f for f in required_fields if f not in conv]
            if not missing:
                log_pass(f"GET /conversas - Returns {len(conversas)} conversas with correct structure")
            else:
                log_fail("GET /conversas - Missing fields", f"Missing: {missing}")
        else:
            log_fail("GET /conversas - Count", f"Expected >=3, got {len(conversas)}")
    else:
        log_fail("GET /conversas", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # B.2 - GET /conversas?status=nao_lidas - Filter by nao_lidas>0
    print("\nB.2 - GET /conversas?status=nao_lidas - Filter by nao_lidas>0...")
    resp = requests.get(f"{BASE_URL}/conversas?status=nao_lidas", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        # All should have nao_lidas > 0
        all_have_nao_lidas = all(c.get("nao_lidas", 0) > 0 for c in conversas)
        if all_have_nao_lidas and len(conversas) > 0:
            log_pass(f"GET /conversas?status=nao_lidas - Returns {len(conversas)} conversas with nao_lidas>0")
        else:
            log_fail("GET /conversas?status=nao_lidas", f"Filter not working correctly, got {len(conversas)} conversas")
    else:
        log_fail("GET /conversas?status=nao_lidas", f"Status {resp.status_code}: {resp.text}")
    
    # B.3 - GET /conversas?pedido_status=sem_pedido - Filter by no pedido
    print("\nB.3 - GET /conversas?pedido_status=sem_pedido - Filter by no pedido...")
    resp = requests.get(f"{BASE_URL}/conversas?pedido_status=sem_pedido", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        # All should have tem_pedido = false
        all_sem_pedido = all(not c.get("tem_pedido", False) for c in conversas)
        if all_sem_pedido:
            log_pass(f"GET /conversas?pedido_status=sem_pedido - Returns {len(conversas)} conversas without pedido")
        else:
            log_fail("GET /conversas?pedido_status=sem_pedido", f"Filter not working, some have pedido")
    else:
        log_fail("GET /conversas?pedido_status=sem_pedido", f"Status {resp.status_code}: {resp.text}")
    
    # B.4 - GET /conversas?q=Maria - Search by name
    print("\nB.4 - GET /conversas?q=Maria - Search by name...")
    resp = requests.get(f"{BASE_URL}/conversas?q=Maria", headers=headers)
    if resp.status_code == 200:
        conversas = resp.json()
        # All should have "Maria" in contato_nome
        all_have_maria = all("Maria" in c.get("contato_nome", "") or "Maria" in c.get("contato_numero", "") for c in conversas)
        if all_have_maria and len(conversas) > 0:
            log_pass(f"GET /conversas?q=Maria - Returns {len(conversas)} conversas with 'Maria'")
        else:
            log_fail("GET /conversas?q=Maria", f"Search not working correctly")
    else:
        log_fail("GET /conversas?q=Maria", f"Status {resp.status_code}: {resp.text}")
    
    # B.5 - GET /conversas/metrics
    print("\nB.5 - GET /conversas/metrics - Get metrics...")
    resp = requests.get(f"{BASE_URL}/conversas/metrics", headers=headers)
    if resp.status_code == 200:
        metrics = resp.json()
        required_fields = ["abertas", "aguardando_equipe", "aguardando_cliente", "resolvidas", "nao_lidas", 
                          "pedidos_andamento", "pedidos_prontos", "pedidos_entrega", "pedidos_entregues_hoje", "tempo_medio_min"]
        missing = [f for f in required_fields if f not in metrics]
        if not missing:
            log_pass(f"GET /conversas/metrics - Returns all required fields: {metrics}")
        else:
            log_fail("GET /conversas/metrics - Missing fields", f"Missing: {missing}")
    else:
        log_fail("GET /conversas/metrics", f"Status {resp.status_code}: {resp.text}")
    
    # B.6 - GET /conversas/:id - Get single conversa with details
    print("\nB.6 - GET /conversas/:id - Get single conversa...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}", headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            required_fields = ["conversa", "cliente", "pedido_ativo", "historico"]
            missing = [f for f in required_fields if f not in data]
            if not missing:
                # Verify historico structure
                hist = data.get("historico", {})
                hist_fields = ["total_pedidos", "ticket_medio", "ultimo_pedido"]
                hist_missing = [f for f in hist_fields if f not in hist]
                if not hist_missing:
                    log_pass("GET /conversas/:id - Returns conversa, cliente, pedido_ativo, historico with correct structure")
                else:
                    log_fail("GET /conversas/:id - Historico missing fields", f"Missing: {hist_missing}")
            else:
                log_fail("GET /conversas/:id - Missing fields", f"Missing: {missing}")
        else:
            log_fail("GET /conversas/:id", f"Status {resp.status_code}: {resp.text}")
    
    # B.7 - GET /conversas/:id/mensagens - Get mensagens ordered by created_at asc
    print("\nB.7 - GET /conversas/:id/mensagens - Get mensagens ordered...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/mensagens", headers=headers)
        if resp.status_code == 200:
            mensagens = resp.json()
            if len(mensagens) >= 2:
                # Verify ordering (created_at should be ascending)
                dates = [m.get("created_at") for m in mensagens]
                is_ordered = all(dates[i] <= dates[i+1] for i in range(len(dates)-1))
                if is_ordered:
                    log_pass(f"GET /conversas/:id/mensagens - Returns {len(mensagens)} mensagens ordered by created_at asc")
                else:
                    log_fail("GET /conversas/:id/mensagens - Not ordered", f"Dates: {dates}")
            else:
                log_fail("GET /conversas/:id/mensagens - Count", f"Expected >=2, got {len(mensagens)}")
        else:
            log_fail("GET /conversas/:id/mensagens", f"Status {resp.status_code}: {resp.text}")

    # ========================================================================
    # C) ENVIO DE MENSAGEM (should NOT mock - must return 400 without Evolution)
    # ========================================================================
    print_section("C) ENVIO DE MENSAGEM (must return 400 without Evolution)")
    
    # C.1 - POST /conversas/:id/mensagens without Evolution config - should return 400
    print("C.1 - POST /conversas/:id/mensagens without Evolution - Should return 400...")
    if "webhook_conversa_id" in tenant_a:
        msg_body = {"texto": "Ola! Como posso ajudar?"}
        resp = requests.post(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/mensagens", 
                           json=msg_body, headers=headers)
        if resp.status_code == 400:
            data = resp.json()
            if "Evolution API nao configurada" in data.get("error", ""):
                log_pass("POST /conversas/:id/mensagens - Returns 400 'Evolution API nao configurada' (NOT mocking)")
            else:
                log_fail("POST /conversas/:id/mensagens - Wrong error message", f"Expected 'Evolution API nao configurada', got {data}")
        else:
            log_fail("POST /conversas/:id/mensagens - Wrong status", f"Expected 400, got {resp.status_code}: {resp.text}", critical=True)
    
    # C.2 - POST /conversas/:id/ler - Mark as read (zero nao_lidas)
    print("\nC.2 - POST /conversas/:id/ler - Mark as read...")
    if "webhook_conversa_id" in tenant_a:
        resp = requests.post(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}/ler", headers=headers)
        if resp.status_code == 200:
            # Verify nao_lidas is now 0
            resp2 = requests.get(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}", headers=headers)
            if resp2.status_code == 200:
                data = resp2.json()
                if data.get("conversa", {}).get("nao_lidas", -1) == 0:
                    log_pass("POST /conversas/:id/ler - nao_lidas zeroed")
                else:
                    log_fail("POST /conversas/:id/ler - nao_lidas not zeroed", f"Expected 0, got {data.get('conversa', {}).get('nao_lidas')}")
            else:
                log_fail("POST /conversas/:id/ler - Verify failed", f"Status {resp2.status_code}")
        else:
            log_fail("POST /conversas/:id/ler", f"Status {resp.status_code}: {resp.text}")
    
    # C.3 - PUT /conversas/:id {status:"RESOLVIDA"} - Update status
    print("\nC.3 - PUT /conversas/:id {status:'RESOLVIDA'} - Update status...")
    if "webhook_conversa_id" in tenant_a:
        update_body = {"status": "RESOLVIDA"}
        resp = requests.put(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}", 
                          json=update_body, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "RESOLVIDA":
                log_pass("PUT /conversas/:id - Status updated to RESOLVIDA")
            else:
                log_fail("PUT /conversas/:id - Status not updated", f"Expected RESOLVIDA, got {data.get('status')}")
        else:
            log_fail("PUT /conversas/:id", f"Status {resp.status_code}: {resp.text}")
    
    # C.4 - PUT /conversas/:id {status:"INVALIDO"} - Invalid status should be ignored
    print("\nC.4 - PUT /conversas/:id {status:'INVALIDO'} - Invalid status should be ignored...")
    if "webhook_conversa_id" in tenant_a:
        update_body = {"status": "INVALIDO"}
        resp = requests.put(f"{BASE_URL}/conversas/{tenant_a['webhook_conversa_id']}", 
                          json=update_body, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            # Status should still be RESOLVIDA (not changed to INVALIDO)
            if data.get("status") == "RESOLVIDA":
                log_pass("PUT /conversas/:id - Invalid status ignored (kept RESOLVIDA)")
            else:
                log_fail("PUT /conversas/:id - Invalid status accepted", f"Expected RESOLVIDA, got {data.get('status')}")
        else:
            log_fail("PUT /conversas/:id", f"Status {resp.status_code}: {resp.text}")

    # ========================================================================
    # D) RELATORIO FINANCEIRO (real data)
    # ========================================================================
    print_section("D) RELATORIO FINANCEIRO (real data)")
    
    # D.1 - GET /financeiro/relatorio (default last 30 days)
    print("D.1 - GET /financeiro/relatorio - Default last 30 days...")
    resp = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        # Verify structure
        required_fields = ["periodo", "kpis", "serie", "porFormaPagamento", "tabela"]
        missing = [f for f in required_fields if f not in data]
        if not missing:
            kpis = data.get("kpis", {})
            kpis_fields = ["faturamento_bruto", "faturamento_liquido", "total_pedidos", "ticket_medio", 
                          "receitas", "despesas", "saldo", "recebidos", "pendentes", "cancelados_reembolsados"]
            kpis_missing = [f for f in kpis_fields if f not in kpis]
            if not kpis_missing:
                # Verify values are numeric and > 0 (since we have seed data)
                if (kpis.get("faturamento_bruto", 0) > 0 and 
                    kpis.get("total_pedidos", 0) > 0 and
                    isinstance(kpis.get("receitas"), (int, float))):
                    log_pass(f"GET /financeiro/relatorio - Returns correct structure with real data: faturamento_bruto={kpis['faturamento_bruto']}, total_pedidos={kpis['total_pedidos']}")
                else:
                    log_fail("GET /financeiro/relatorio - Values not numeric or zero", f"KPIs: {kpis}")
            else:
                log_fail("GET /financeiro/relatorio - KPIs missing fields", f"Missing: {kpis_missing}")
        else:
            log_fail("GET /financeiro/relatorio - Missing fields", f"Missing: {missing}")
    else:
        log_fail("GET /financeiro/relatorio", f"Status {resp.status_code}: {resp.text}", critical=True)
    
    # D.2 - GET /financeiro/relatorio?inicio=2020-01-01&fim=2020-01-02 - Period without data
    print("\nD.2 - GET /financeiro/relatorio?inicio=2020-01-01&fim=2020-01-02 - Period without data...")
    resp = requests.get(f"{BASE_URL}/financeiro/relatorio?inicio=2020-01-01&fim=2020-01-02", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        kpis = data.get("kpis", {})
        tabela = data.get("tabela", [])
        # All KPIs should be 0 or near 0, tabela should be empty
        if (kpis.get("faturamento_bruto", -1) == 0 and 
            kpis.get("total_pedidos", -1) == 0 and
            len(tabela) == 0):
            log_pass("GET /financeiro/relatorio - Period without data returns zeros and empty tabela")
        else:
            log_fail("GET /financeiro/relatorio - Period without data", f"Expected zeros, got KPIs: {kpis}, tabela: {len(tabela)}")
    else:
        log_fail("GET /financeiro/relatorio - Period without data", f"Status {resp.status_code}: {resp.text}")
    
    # D.3 - GET /financeiro/relatorio?pagamento=pix - Filter by payment method
    print("\nD.3 - GET /financeiro/relatorio?pagamento=pix - Filter by payment method...")
    resp = requests.get(f"{BASE_URL}/financeiro/relatorio?pagamento=pix", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        tabela = data.get("tabela", [])
        # All items in tabela should have pagamento=pix
        all_pix = all(item.get("pagamento") == "pix" for item in tabela)
        if all_pix or len(tabela) == 0:
            log_pass(f"GET /financeiro/relatorio?pagamento=pix - Filter working ({len(tabela)} items)")
        else:
            log_fail("GET /financeiro/relatorio?pagamento=pix", f"Filter not working, found non-pix items")
    else:
        log_fail("GET /financeiro/relatorio?pagamento=pix", f"Status {resp.status_code}: {resp.text}")
    
    # D.4 - GET /financeiro/relatorio?status=entregue - Filter by status
    print("\nD.4 - GET /financeiro/relatorio?status=entregue - Filter by status...")
    resp = requests.get(f"{BASE_URL}/financeiro/relatorio?status=entregue", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        tabela = data.get("tabela", [])
        # All items should have status in ['concluido', 'ENTREGUE']
        all_entregue = all(item.get("status") in ["concluido", "ENTREGUE"] for item in tabela)
        if all_entregue or len(tabela) == 0:
            log_pass(f"GET /financeiro/relatorio?status=entregue - Filter working ({len(tabela)} items)")
        else:
            log_fail("GET /financeiro/relatorio?status=entregue", f"Filter not working")
    else:
        log_fail("GET /financeiro/relatorio?status=entregue", f"Status {resp.status_code}: {resp.text}")
    
    # D.5 - GET /financeiro/relatorio?tipo=delivery - Filter by tipo
    print("\nD.5 - GET /financeiro/relatorio?tipo=delivery - Filter by tipo...")
    resp = requests.get(f"{BASE_URL}/financeiro/relatorio?tipo=delivery", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        tabela = data.get("tabela", [])
        # All items should have origem=delivery
        all_delivery = all(item.get("origem") == "delivery" for item in tabela)
        if all_delivery or len(tabela) == 0:
            log_pass(f"GET /financeiro/relatorio?tipo=delivery - Filter working ({len(tabela)} items)")
        else:
            log_fail("GET /financeiro/relatorio?tipo=delivery", f"Filter not working")
    else:
        log_fail("GET /financeiro/relatorio?tipo=delivery", f"Status {resp.status_code}: {resp.text}")

    # ========================================================================
    # E) REGRESSION / MULTITENANCY
    # ========================================================================
    print_section("E) REGRESSION / MULTITENANCY")
    
    # E.1 - PUT /pedidos/:id {status:"ENTREGUE"} - Should create receita transaction
    print("E.1 - PUT /pedidos/:id {status:'ENTREGUE'} - Should create receita transaction...")
    
    # First, get a pedido that is not in final status
    resp = requests.get(f"{BASE_URL}/pedidos", headers=headers)
    if resp.status_code == 200:
        pedidos = resp.json()
        # Find a pedido that is not concluido or ENTREGUE
        pedido_to_update = None
        for p in pedidos:
            if p.get("status") not in ["concluido", "ENTREGUE", "cancelado", "CANCELADO"]:
                pedido_to_update = p
                break
        
        if pedido_to_update:
            pedido_id = pedido_to_update["id"]
            pedido_total = pedido_to_update["total"]
            
            # Get current transacoes count
            resp2 = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers)
            if resp2.status_code == 200:
                transacoes_before = resp2.json()
                count_before = len(transacoes_before)
                
                # Update pedido to ENTREGUE
                update_body = {"status": "ENTREGUE"}
                resp3 = requests.put(f"{BASE_URL}/pedidos/{pedido_id}", json=update_body, headers=headers)
                if resp3.status_code == 200:
                    # Get transacoes again
                    resp4 = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers)
                    if resp4.status_code == 200:
                        transacoes_after = resp4.json()
                        count_after = len(transacoes_after)
                        
                        if count_after > count_before:
                            # Find the new transacao
                            new_transacao = next((t for t in transacoes_after if t.get("pedido_id") == pedido_id), None)
                            if new_transacao and new_transacao.get("tipo") == "receita" and new_transacao.get("valor") == pedido_total:
                                log_pass(f"PUT /pedidos/:id status=ENTREGUE - Creates receita transaction (count: {count_before}->{count_after}, valor={pedido_total})")
                            else:
                                log_fail("PUT /pedidos/:id - Transacao not correct", f"Expected receita with valor={pedido_total}, got {new_transacao}")
                        else:
                            log_fail("PUT /pedidos/:id - Transacao not created", f"Count before={count_before}, after={count_after}", critical=True)
                    else:
                        log_fail("PUT /pedidos/:id - Get transacoes after", f"Status {resp4.status_code}")
                else:
                    log_fail("PUT /pedidos/:id", f"Status {resp3.status_code}: {resp3.text}")
            else:
                log_fail("PUT /pedidos/:id - Get transacoes before", f"Status {resp2.status_code}")
        else:
            print("   ⚠️  SKIP: No pedido available for update (all are in final status)")
    else:
        log_fail("PUT /pedidos/:id - Get pedidos", f"Status {resp.status_code}: {resp.text}")
    
    # E.2 - Register 2nd empresa and verify conversation isolation
    print("\nE.2 - Register 2nd empresa and verify conversation isolation...")
    tenant_b_email = random_email()
    register_data_b = {
        "empresa_nome": "Pizzaria Napolitana",
        "nome": "João Santos",
        "email": tenant_b_email,
        "senha": "senha_segura_456"
    }
    
    resp = requests.post(f"{BASE_URL}/auth/register", json=register_data_b)
    if resp.status_code == 200:
        data = resp.json()
        tenant_b["token"] = data["token"]
        tenant_b["empresa_id"] = data["empresa"]["id"]
        log_pass(f"Register Tenant B - empresa_id: {tenant_b['empresa_id']}")
        
        # Get conversas for Tenant B (should have only 2 from seed, not the webhook one from Tenant A)
        headers_b = {"Authorization": f"Bearer {tenant_b['token']}"}
        resp2 = requests.get(f"{BASE_URL}/conversas", headers=headers_b)
        if resp2.status_code == 200:
            conversas_b = resp2.json()
            # Should have 2 from seed, NOT 3 (webhook conversa from Tenant A should not appear)
            if len(conversas_b) == 2:
                # Verify none have the webhook number
                has_webhook_number = any(c.get("contato_numero") == "5511977776666" for c in conversas_b)
                if not has_webhook_number:
                    log_pass(f"Multitenancy - Tenant B has 2 conversas (seed only), NOT seeing Tenant A's webhook conversa")
                else:
                    log_fail("Multitenancy - Data leak", f"Tenant B can see Tenant A's conversa", critical=True)
            else:
                log_fail("Multitenancy - Wrong count", f"Expected 2 conversas for Tenant B, got {len(conversas_b)}")
        else:
            log_fail("Multitenancy - GET conversas Tenant B", f"Status {resp2.status_code}: {resp2.text}")
    else:
        log_fail("Register Tenant B", f"Status {resp.status_code}: {resp.text}")
    
    # E.3 - Verify old flows still work: GET /mesas
    print("\nE.3 - GET /mesas - Verify old flow still works...")
    resp = requests.get(f"{BASE_URL}/mesas", headers=headers)
    if resp.status_code == 200:
        mesas = resp.json()
        if len(mesas) >= 8:
            log_pass(f"GET /mesas - Old flow working ({len(mesas)} mesas)")
        else:
            log_fail("GET /mesas - Wrong count", f"Expected >=8, got {len(mesas)}")
    else:
        log_fail("GET /mesas", f"Status {resp.status_code}: {resp.text}")
    
    # E.4 - Verify old flows: GET /dashboard/metrics
    print("\nE.4 - GET /dashboard/metrics - Verify old flow still works...")
    resp = requests.get(f"{BASE_URL}/dashboard/metrics", headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        required_fields = ["faturamentoHoje", "pedidosHoje", "ticketMedio", "totalClientes", "totalProdutos", "serie", "topProdutos", "recentes", "porStatus"]
        missing = [f for f in required_fields if f not in data]
        if not missing:
            log_pass("GET /dashboard/metrics - Old flow working with all fields")
        else:
            log_fail("GET /dashboard/metrics - Missing fields", f"Missing: {missing}")
    else:
        log_fail("GET /dashboard/metrics", f"Status {resp.status_code}: {resp.text}")
    
    # E.5 - Verify old flows: GET /pedidos
    print("\nE.5 - GET /pedidos - Verify old flow still works...")
    resp = requests.get(f"{BASE_URL}/pedidos", headers=headers)
    if resp.status_code == 200:
        pedidos = resp.json()
        if len(pedidos) > 0:
            log_pass(f"GET /pedidos - Old flow working ({len(pedidos)} pedidos)")
        else:
            log_fail("GET /pedidos - No pedidos", f"Expected >0, got {len(pedidos)}")
    else:
        log_fail("GET /pedidos", f"Status {resp.status_code}: {resp.text}")

except Exception as e:
    print(f"\n❌ CRITICAL ERROR: {str(e)}")
    import traceback
    traceback.print_exc()
    results["critical_failures"].append({"test": "EXCEPTION", "reason": str(e)})

# ========================================================================
# FINAL SUMMARY
# ========================================================================
print_section("FINAL SUMMARY")

total_tests = len(results["passed"]) + len(results["failed"])
print(f"Total Tests: {total_tests}")
print(f"✅ Passed: {len(results['passed'])}")
print(f"❌ Failed: {len(results['failed'])}")
print(f"🔴 Critical Failures: {len(results['critical_failures'])}")

if results["failed"]:
    print("\n❌ FAILED TESTS:")
    for fail in results["failed"]:
        print(f"  - {fail['test']}: {fail['reason']}")

if results["critical_failures"]:
    print("\n🔴 CRITICAL FAILURES:")
    for fail in results["critical_failures"]:
        print(f"  - {fail['test']}: {fail['reason']}")

print("\n" + "="*80)
if len(results["critical_failures"]) == 0 and len(results["failed"]) == 0:
    print("✅ ALL TESTS PASSED - RESTAURANT OS V3 BACKEND IS PRODUCTION-READY")
elif len(results["critical_failures"]) == 0:
    print("⚠️  SOME TESTS FAILED BUT NO CRITICAL FAILURES")
else:
    print("🔴 CRITICAL FAILURES DETECTED - NEEDS ATTENTION")
print("="*80)
