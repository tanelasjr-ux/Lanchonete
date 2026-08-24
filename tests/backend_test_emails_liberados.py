"""Controle de acesso ao cadastro: allowlist de e-mails liberados pelo
dono da ETNA (Painel ETNA) para completar POST /auth/register.

O gate em si (POST /auth/register recusando e-mail nao liberado) NAO e
testavel nesta suite rodando com SIGNUP_ALLOWLIST_DISABLED=1 (ambiente
padrao de toda a regressao local) — ver test_gate_manual.py para os 2
testes que precisam de um servidor SEM a flag.
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
    return {"Authorization": f"Bearer {r.json()['token']}"}, email


def promover_plataforma_admin(email):
    """Insere direto no Mongo local — mesmo mecanismo ja usado nesta sessao
    para testar o Painel ETNA (nao ha endpoint de auto-promocao, de proposito:
    so quem ja tem acesso ao banco vira admin da plataforma)."""
    from pymongo import MongoClient
    import uuid
    from datetime import datetime, timezone
    db = MongoClient("mongodb://localhost:27017")["restaurant_os_dev"]
    db.plataforma_admins.update_one(
        {"email": email},
        {"$set": {"id": str(uuid.uuid4()), "email": email, "nome": "Admin Teste", "ativo": True, "created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )


def test_liberar_email_cria_registro_pendente():
    headers, email = criar_empresa("Acesso Admin Liberar")
    promover_plataforma_admin(email)
    alvo = f"prospect-{os.urandom(4).hex()}@teste.com"
    r = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo, "nome": "Prospect"})
    assert r.status_code == 201, r.text
    corpo = r.json()
    assert corpo["email"] == alvo
    assert corpo["usado_em"] is None


def test_liberar_o_mesmo_email_duas_vezes_da_409():
    headers, email = criar_empresa("Acesso Admin Duplicado")
    promover_plataforma_admin(email)
    alvo = f"dup-{os.urandom(4).hex()}@teste.com"
    primeiro = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    assert primeiro.status_code == 201
    segundo = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    assert segundo.status_code == 409


def test_liberar_email_com_formato_invalido_e_recusado():
    headers, email = criar_empresa("Acesso Admin Formato")
    promover_plataforma_admin(email)
    r = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": "nao-e-email"})
    assert r.status_code == 400


def test_listar_emails_liberados_mostra_status_usado():
    headers, email = criar_empresa("Acesso Admin Listar")
    promover_plataforma_admin(email)
    alvo = f"listagem-{os.urandom(4).hex()}@teste.com"
    requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo})
    lista = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers).json()
    achado = next(i for i in lista if i["email"] == alvo)
    assert achado["usado_em"] is None


def test_remover_email_liberado_tira_da_lista():
    headers, email = criar_empresa("Acesso Admin Remover")
    promover_plataforma_admin(email)
    alvo = f"remover-{os.urandom(4).hex()}@teste.com"
    criado = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": alvo}).json()
    r = requests.delete(f"{BASE_URL}/plataforma/emails-liberados/{criado['id']}", headers=headers)
    assert r.status_code == 200
    lista = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers).json()
    assert not any(i["id"] == criado["id"] for i in lista)


def test_rotas_admin_exigem_admin_da_plataforma():
    headers, email = criar_empresa("Acesso Nao Admin")
    # NAO promove este e-mail a plataforma_admins — usuario comum.
    r = requests.get(f"{BASE_URL}/plataforma/emails-liberados", headers=headers)
    assert r.status_code == 403
    r2 = requests.post(f"{BASE_URL}/plataforma/emails-liberados", headers=headers, json={"email": "x@x.com"})
    assert r2.status_code == 403


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
