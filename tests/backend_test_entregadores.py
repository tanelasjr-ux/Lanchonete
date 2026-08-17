import os
import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")


def criar_empresa(nome):
    """Cria empresa + usuario OWNER via /auth/register e devolve headers autenticados."""
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_get_entregadores_retorna_array_puro():
    """GET /entregadores retorna array puro, nao {entregadores: [...]}.

    Bug real encontrado em 2026-08-18: o endpoint devolvia
    {entregadores: [...]} enquanto todo outro endpoint de lista do sistema
    (/clientes, /produtos, /mesas) devolve array puro. O frontend chamava
    `.then(setEntregadores)` esperando array puro, guardava o objeto errado
    no estado, e `entregadores.map(...)` no render explodia com
    "entregadores.map is not a function" — crash renderizava a tela de
    Configuracoes inteira em branco, incluindo a aba Cardapio Digital (o QR
    code ficava inacessivel por causa disso, nao por bug no proprio QR).
    """
    headers = criar_empresa("Entregador Array")
    res = requests.get(f"{BASE_URL}/entregadores", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert isinstance(data, list), f"esperado array puro, veio {type(data).__name__}: {data}"
    assert data == [], "empresa nova nao tem entregador cadastrado"


def test_post_entregador_retorna_objeto_puro_e_aparece_no_get():
    """POST /entregadores retorna o objeto puro (nao {entregador: {...}}) e
    o entregador criado aparece no GET seguinte."""
    headers = criar_empresa("Entregador Post")
    r = requests.post(f"{BASE_URL}/entregadores", json={"nome": "Carlos Motoboy", "telefone": "11999990000"}, headers=headers)
    assert r.status_code == 201
    entregador = r.json()
    assert isinstance(entregador, dict)
    assert entregador.get("nome") == "Carlos Motoboy", f"esperado objeto puro com 'nome', veio {entregador}"
    assert entregador.get("ativo") is True
    assert "id" in entregador

    res = requests.get(f"{BASE_URL}/entregadores", headers=headers)
    lista = res.json()
    assert isinstance(lista, list)
    assert any(e["id"] == entregador["id"] and e["nome"] == "Carlos Motoboy" for e in lista)


def test_put_entregador_retorna_objeto_puro_e_atualiza():
    """PUT /entregadores/:id retorna objeto puro e o campo ativo muda de fato."""
    headers = criar_empresa("Entregador Put")
    criado = requests.post(f"{BASE_URL}/entregadores", json={"nome": "Ana Entrega", "telefone": ""}, headers=headers).json()

    r = requests.put(f"{BASE_URL}/entregadores/{criado['id']}", json={"ativo": False}, headers=headers)
    assert r.status_code == 200
    atualizado = r.json()
    assert isinstance(atualizado, dict)
    assert atualizado.get("ativo") is False, f"esperado objeto puro com 'ativo':False, veio {atualizado}"

    lista = requests.get(f"{BASE_URL}/entregadores", headers=headers).json()
    achado = next(e for e in lista if e["id"] == criado["id"])
    assert achado["ativo"] is False


def test_entregadores_multitenant():
    """Entregador de uma empresa nao aparece na lista de outra."""
    headers_a = criar_empresa("Entregador Multi A")
    headers_b = criar_empresa("Entregador Multi B")

    requests.post(f"{BASE_URL}/entregadores", json={"nome": "Entregador Exclusivo A", "telefone": ""}, headers=headers_a)

    lista_b = requests.get(f"{BASE_URL}/entregadores", headers=headers_b).json()
    assert "Entregador Exclusivo A" not in [e["nome"] for e in lista_b]


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
