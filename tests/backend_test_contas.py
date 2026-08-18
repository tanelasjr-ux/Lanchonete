"""Contas a pagar/receber com vencimento.

Camada de OBRIGACAO (o que ainda vai vencer), complementar a `transacoes` (a
camada de CAIXA — o que ja aconteceu). Uma conta so entra em qualquer numero
do relatorio financeiro depois de PAGA, porque so ai vira uma transacao de
verdade. "Atrasada" nunca e um status gravado — e sempre derivado de
vencimento < hoje na leitura.
"""
import os
from datetime import datetime, timedelta, timezone

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


def dia(offset):
    """Data (YYYY-MM-DD) `offset` dias a partir de hoje. Negativo = passado."""
    return (datetime.now(timezone.utc) + timedelta(days=offset)).strftime("%Y-%m-%d")


def criar_conta(headers, tipo="pagar", valor=100, vencimento=None, categoria="Aluguel", natureza=None):
    body = {"tipo": tipo, "descricao": "Teste", "categoria": categoria,
            "valor": valor, "vencimento": vencimento or dia(10)}
    if natureza:
        body["natureza"] = natureza
    r = requests.post(f"{BASE_URL}/contas", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def listar(headers, **params):
    r = requests.get(f"{BASE_URL}/contas", headers=headers, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def por_id(resposta, conta_id):
    return next((c for c in resposta["contas"] if c["id"] == conta_id), None)


def test_criar_conta_a_pagar():
    headers = criar_empresa("Criar Pagar")
    c = criar_conta(headers, tipo="pagar", valor=1500, categoria="Aluguel", natureza="fixa")
    assert c["status"] == "pendente"
    assert c["status_efetivo"] == "pendente"
    assert c["transacao_id"] is None
    assert c["pago_em"] is None


def test_valor_zero_ou_negativo_e_rejeitado():
    headers = criar_empresa("Valor Invalido")
    for valor in (0, -50):
        r = requests.post(f"{BASE_URL}/contas", headers=headers, json={
            "tipo": "pagar", "categoria": "Aluguel", "valor": valor, "vencimento": dia(5),
        })
        assert r.status_code == 400, f"valor {valor} deveria ser rejeitado"


def test_tipo_invalido_e_rejeitado():
    headers = criar_empresa("Tipo Invalido")
    r = requests.post(f"{BASE_URL}/contas", headers=headers, json={
        "tipo": "emprestimo", "categoria": "X", "valor": 100, "vencimento": dia(5),
    })
    assert r.status_code == 400


def test_natureza_invalida_vira_null_nunca_inventada():
    """Mesma regra de transacoes.natureza (0022): valor fora do vocabulario vira null, nao erro nem chute."""
    headers = criar_empresa("Natureza Invalida Conta")
    r = requests.post(f"{BASE_URL}/contas", headers=headers, json={
        "tipo": "pagar", "categoria": "Aluguel", "valor": 100, "vencimento": dia(5), "natureza": "chute",
    })
    assert r.status_code == 201
    assert r.json()["natureza"] is None


def test_status_efetivo_atrasada_e_derivado_nunca_gravado():
    """Conta com vencimento no passado aparece como 'atrasada' na leitura, mas o status gravado continua 'pendente'."""
    headers = criar_empresa("Atrasada Derivada")
    c = criar_conta(headers, vencimento=dia(-5))
    assert c["status"] == "pendente", "o campo persistido nunca deveria ser 'atrasada'"
    assert c["status_efetivo"] == "atrasada"

    # Confirma direto na listagem tambem.
    lst = listar(headers)
    achada = por_id(lst, c["id"])
    assert achada["status_efetivo"] == "atrasada"
    assert achada["status"] == "pendente"


def test_vencimento_hoje_nao_e_atrasada():
    """Regressao de fuso horario: `vencimento` e data pura, sempre lida como
    meia-noite UTC. Comparar contra "hoje" em hora local do servidor fazia um
    vencimento genuinamente hoje parecer atrasado sempre que o servidor
    rodasse num fuso atras de UTC (ex: horario do Brasil). Bug real, achado
    escrevendo este teste — nao proteção teorica."""
    headers = criar_empresa("Vence Hoje")
    c = criar_conta(headers, vencimento=dia(0))
    assert c["status_efetivo"] == "pendente", "vencer hoje ainda nao e atraso"


def test_pagar_conta_cria_transacao_e_atualiza_status():
    headers = criar_empresa("Pagar Cria Transacao")
    c = criar_conta(headers, tipo="pagar", valor=800, categoria="Insumos", natureza="variavel")

    r = requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})
    assert r.status_code == 200, r.text
    paga = r.json()
    assert paga["status"] == "paga"
    assert paga["status_efetivo"] == "paga"
    assert paga["transacao_id"] is not None
    assert paga["pago_em"] is not None

    tx = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()
    gerada = next((t for t in tx if t["id"] == paga["transacao_id"]), None)
    assert gerada is not None, "a transacao referenciada precisa existir de verdade"
    assert gerada["tipo"] == "despesa"
    assert gerada["valor"] == 800
    assert gerada["categoria"] == "Insumos"
    assert gerada["natureza"] == "variavel"


def test_pagar_conta_a_receber_gera_transacao_tipo_receita():
    headers = criar_empresa("Receber Gera Receita")
    c = criar_conta(headers, tipo="receber", valor=350, categoria="Cliente XPTO")
    r = requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})
    assert r.status_code == 200

    tx = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()
    gerada = next((t for t in tx if t["id"] == r.json()["transacao_id"]), None)
    assert gerada["tipo"] == "receita"
    assert gerada["valor"] == 350


def test_conta_paga_afeta_dre_conta_pendente_nao():
    """A obrigacao so vira numero do relatorio depois de paga — nunca antes."""
    headers = criar_empresa("Pendente Fora Do Dre")
    c1 = criar_conta(headers, tipo="pagar", valor=2000, categoria="Aluguel", natureza="fixa")
    c2 = criar_conta(headers, tipo="pagar", valor=500, categoria="Aluguel", natureza="fixa")

    dre_antes = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers).json()["dre"]
    assert dre_antes["despesas_fixas"] == 0, "conta pendente nao pode aparecer no DRE"

    requests.put(f"{BASE_URL}/contas/{c1['id']}/pagar", headers=headers, json={})
    dre_depois = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers).json()["dre"]
    assert dre_depois["despesas_fixas"] == 2000, "so a conta PAGA deveria contar"


def test_nao_pode_pagar_conta_ja_paga_ou_cancelada():
    headers = criar_empresa("Pagar Duas Vezes")
    c = criar_conta(headers)
    requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})

    r = requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})
    assert r.status_code == 409, "pagar uma conta ja paga geraria uma segunda transacao"


def test_cancelar_conta_pendente():
    headers = criar_empresa("Cancelar Pendente")
    c = criar_conta(headers)
    r = requests.put(f"{BASE_URL}/contas/{c['id']}/cancelar", headers=headers, json={})
    assert r.status_code == 200
    assert r.json()["status"] == "cancelada"
    assert r.json()["transacao_id"] is None, "cancelar nunca gera transacao"


def test_nao_pode_cancelar_conta_ja_paga():
    headers = criar_empresa("Cancelar Paga")
    c = criar_conta(headers)
    requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})
    r = requests.put(f"{BASE_URL}/contas/{c['id']}/cancelar", headers=headers, json={})
    assert r.status_code == 409, "conta paga e fato consumado, nao se cancela"


def test_editar_conta_pendente_funciona():
    headers = criar_empresa("Editar Pendente")
    c = criar_conta(headers, valor=100)
    r = requests.put(f"{BASE_URL}/contas/{c['id']}", headers=headers, json={"valor": 250, "descricao": "Ajustado"})
    assert r.status_code == 200
    assert r.json()["valor"] == 250
    assert r.json()["descricao"] == "Ajustado"


def test_editar_conta_paga_e_bloqueado():
    """Mesma regra de 'pedido concluido nao se edita': ja virou transacao, corrigir por baixo do relatorio seria pior que recusar."""
    headers = criar_empresa("Editar Paga Bloqueado")
    c = criar_conta(headers)
    requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={})
    r = requests.put(f"{BASE_URL}/contas/{c['id']}", headers=headers, json={"valor": 999})
    assert r.status_code == 409


def test_editar_valor_invalido_e_rejeitado():
    headers = criar_empresa("Editar Valor Invalido")
    c = criar_conta(headers)
    r = requests.put(f"{BASE_URL}/contas/{c['id']}", headers=headers, json={"valor": -10})
    assert r.status_code == 400


def test_resumo_soma_pendentes_por_tipo():
    headers = criar_empresa("Resumo Por Tipo")
    criar_conta(headers, tipo="pagar", valor=300)
    criar_conta(headers, tipo="pagar", valor=200)
    criar_conta(headers, tipo="receber", valor=1000)

    resumo = listar(headers)["resumo"]
    assert resumo["a_pagar_total"] == 500
    assert resumo["a_receber_total"] == 1000


def test_resumo_atrasado_separado_do_total():
    headers = criar_empresa("Resumo Atrasado")
    criar_conta(headers, tipo="pagar", valor=100, vencimento=dia(-3))
    criar_conta(headers, tipo="pagar", valor=400, vencimento=dia(20))

    resumo = listar(headers)["resumo"]
    assert resumo["a_pagar_total"] == 500
    assert resumo["a_pagar_atrasado"] == 100
    assert resumo["a_pagar_atrasado_qtd"] == 1


def test_resumo_ignora_conta_paga_e_cancelada():
    """Uma vez resolvida (paga ou cancelada), a conta sai do resumo de pendencias."""
    headers = criar_empresa("Resumo Ignora Resolvida")
    paga = criar_conta(headers, tipo="pagar", valor=500)
    requests.put(f"{BASE_URL}/contas/{paga['id']}/pagar", headers=headers, json={})
    cancelada = criar_conta(headers, tipo="pagar", valor=300)
    requests.put(f"{BASE_URL}/contas/{cancelada['id']}/cancelar", headers=headers, json={})
    criar_conta(headers, tipo="pagar", valor=150)  # esta continua pendente

    resumo = listar(headers)["resumo"]
    assert resumo["a_pagar_total"] == 150, "paga e cancelada nao contam no total pendente"


def test_resumo_proximos_7_dias():
    headers = criar_empresa("Resumo 7 Dias")
    criar_conta(headers, tipo="pagar", valor=100, vencimento=dia(3))    # dentro
    criar_conta(headers, tipo="pagar", valor=200, vencimento=dia(7))    # limite, dentro
    criar_conta(headers, tipo="pagar", valor=300, vencimento=dia(15))   # fora

    resumo = listar(headers)["resumo"]
    assert resumo["proximos_7_dias_qtd"] == 2
    assert resumo["proximos_7_dias_valor"] == 300


def test_filtro_por_tipo_e_status():
    headers = criar_empresa("Filtro Tipo Status")
    criar_conta(headers, tipo="pagar", valor=100)
    a_receber = criar_conta(headers, tipo="receber", valor=200)
    requests.put(f"{BASE_URL}/contas/{a_receber['id']}/pagar", headers=headers, json={})

    so_receber = listar(headers, tipo="receber")["contas"]
    assert all(c["tipo"] == "receber" for c in so_receber)

    so_pagas = listar(headers, status="paga")["contas"]
    assert len(so_pagas) == 1
    assert so_pagas[0]["id"] == a_receber["id"]

    so_atrasadas = listar(headers, vencimento=dia(-1))  # noop, so garante que o filtro nao quebra sem match
    assert so_atrasadas["resumo"] is not None


def test_categorias_despesa_reaproveita_vocabulario_existente():
    """Conta a pagar usa o mesmo catalogo de categorias das despesas — nao reinventa um segundo vocabulario."""
    headers = criar_empresa("Categorias Reuso")
    cats = requests.get(f"{BASE_URL}/financeiro/categorias-despesa", headers=headers).json()
    valores = [c["valor"] for c in cats]
    assert "Aluguel" in valores
    c = criar_conta(headers, categoria="Aluguel")
    assert c["categoria"] == "Aluguel"


def test_contas_isoladas_entre_empresas():
    headers_a = criar_empresa("Contas Multi A")
    headers_b = criar_empresa("Contas Multi B")
    c = criar_conta(headers_a, valor=999)

    lst_b = listar(headers_b)
    assert por_id(lst_b, c["id"]) is None

    # B nao pode pagar/cancelar/editar conta de A.
    assert requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers_b, json={}).status_code == 404
    assert requests.put(f"{BASE_URL}/contas/{c['id']}/cancelar", headers=headers_b, json={}).status_code == 404
    assert requests.put(f"{BASE_URL}/contas/{c['id']}", headers=headers_b, json={"valor": 1}).status_code == 404


def test_papel_sem_permissao_financeiro_nao_acessa_contas():
    """ATENDENTE (sem `financeiro`) nao ve nem cria conta."""
    headers_owner = criar_empresa("Papel Contas")
    at_email = f"at-{os.urandom(4).hex()}@test.com"
    requests.post(f"{BASE_URL}/usuarios", headers=headers_owner, json={
        "nome": "Atendente", "email": at_email, "senha": "senha123", "papel": "ATENDENTE",
    })
    login = requests.post(f"{BASE_URL}/auth/login", json={"email": at_email, "senha": "senha123"})
    headers_at = {"Authorization": f"Bearer {login.json()['token']}"}

    assert requests.get(f"{BASE_URL}/contas", headers=headers_at).status_code == 403
    assert requests.post(f"{BASE_URL}/contas", headers=headers_at, json={
        "tipo": "pagar", "categoria": "X", "valor": 10, "vencimento": dia(5),
    }).status_code == 403


def test_conta_pagar_com_data_retroativa_de_pagamento():
    """`data` no body de /pagar registra QUANDO o dinheiro saiu, nao hoje — regime de caixa, igual ao resto do relatorio."""
    headers = criar_empresa("Data Retroativa Pagamento")
    c = criar_conta(headers, tipo="pagar", valor=100, categoria="Aluguel", natureza="fixa")
    data_pagamento = dia(-10)
    r = requests.put(f"{BASE_URL}/contas/{c['id']}/pagar", headers=headers, json={"data": data_pagamento + "T12:00:00.000Z"})
    assert r.status_code == 200

    tx = requests.get(f"{BASE_URL}/financeiro/transacoes", headers=headers).json()
    gerada = next(t for t in tx if t["id"] == r.json()["transacao_id"])
    assert gerada["data"].startswith(data_pagamento)


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
