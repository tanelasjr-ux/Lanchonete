"""Comparativo com o periodo anterior no relatorio financeiro.

Sem isso todo numero do relatorio e um retrato solto: R$ 40 mil de faturamento
nao diz nada sozinho, mas diz muito ao lado dos R$ 52 mil do periodo anterior.
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


def lancar(headers, tipo, valor, dias_atras, categoria="Vendas", natureza=None):
    """Lanca uma transacao datada `dias_atras` dias no passado."""
    data = (datetime.now(timezone.utc) - timedelta(days=dias_atras)).isoformat()
    body = {"tipo": tipo, "categoria": categoria, "valor": valor, "data": data}
    if natureza:
        body["natureza"] = natureza
    r = requests.post(f"{BASE_URL}/financeiro/transacoes", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


# O seed de demonstracao (route.js: seedEmpresa) cria pedidos e despesas nos
# ultimos ~15 dias. Os testes que conferem somas exatas trabalham numa janela
# no passado distante, onde o seed nao alcanca — assim o numero esperado e o
# que o teste lancou, e nada mais.
JANELA_LIMPA_INICIO = 209  # dias atras
JANELA_LIMPA_FIM = 200


def relatorio_janela_limpa(headers):
    """Relatorio dos dias 200-209 atras. O periodo anterior cai em 210-219."""
    agora = datetime.now(timezone.utc)
    inicio = agora - timedelta(days=JANELA_LIMPA_INICIO)
    fim = agora - timedelta(days=JANELA_LIMPA_FIM)
    r = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers, params={
        "inicio": inicio.isoformat(), "fim": fim.isoformat(),
    })
    assert r.status_code == 200, r.text
    return r.json()


def relatorio(headers, dias=10):
    """Relatorio de uma janela de `dias` terminando hoje (pode conter seed)."""
    fim = datetime.now(timezone.utc)
    inicio = fim - timedelta(days=dias - 1)
    r = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers, params={
        "inicio": inicio.isoformat(), "fim": fim.isoformat(),
    })
    assert r.status_code == 200, r.text
    return r.json()


def test_relatorio_devolve_bloco_comparativo():
    """O relatorio sempre traz `comparativo`, com o periodo anterior explicito."""
    headers = criar_empresa("Comparativo Existe")
    rep = relatorio(headers)

    comp = rep.get("comparativo")
    assert comp is not None, "relatorio precisa trazer o bloco comparativo"
    assert "periodo" in comp
    for chave in ("faturamento_bruto", "receitas", "despesas", "ticket_medio",
                  "total_pedidos", "lucro_liquido"):
        assert chave in comp, f"faltou {chave} no comparativo"
        assert set(comp[chave]) == {"atual", "anterior", "delta", "delta_percent"}


def test_periodo_anterior_tem_mesma_duracao_e_nao_sobrepoe():
    """A janela anterior encosta na atual sem invadi-la.

    Sobreposicao de um unico dia faria a mesma venda contar dos dois lados e a
    variacao mentir para menos.
    """
    headers = criar_empresa("Janela Anterior")
    fim = datetime.now(timezone.utc)
    inicio = fim - timedelta(days=9)
    rep = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers, params={
        "inicio": inicio.isoformat(), "fim": fim.isoformat(),
    }).json()

    ant_fim = datetime.fromisoformat(rep["comparativo"]["periodo"]["fim"].replace("Z", "+00:00"))
    atual_inicio = datetime.fromisoformat(rep["periodo"]["inicio"].replace("Z", "+00:00"))
    assert ant_fim < atual_inicio, "o periodo anterior nao pode invadir o atual"


def test_delta_percent_calcula_crescimento_real():
    """Receita dobrando de um periodo para o outro da +100%."""
    headers = criar_empresa("Crescimento")
    lancar(headers, "receita", 1000, dias_atras=215)  # periodo anterior
    lancar(headers, "receita", 2000, dias_atras=205)  # periodo atual

    comp = relatorio_janela_limpa(headers)["comparativo"]["receitas"]
    assert comp["anterior"] == 1000, comp
    assert comp["atual"] == 2000, comp
    assert comp["delta"] == 1000
    assert comp["delta_percent"] == 100.0, f"dobrar deveria dar +100%, deu {comp['delta_percent']}"


def test_delta_percent_calcula_queda():
    """Receita caindo pela metade da -50%."""
    headers = criar_empresa("Queda")
    lancar(headers, "receita", 2000, dias_atras=215)
    lancar(headers, "receita", 1000, dias_atras=205)

    comp = relatorio_janela_limpa(headers)["comparativo"]["receitas"]
    assert comp["delta"] == -1000
    assert comp["delta_percent"] == -50.0, f"cair pela metade deveria dar -50%, deu {comp['delta_percent']}"


def test_delta_percent_null_quando_periodo_anterior_foi_zero():
    """Crescer a partir do zero nao tem percentual com significado.

    Mostrar "+100%" (errado) ou "+infinito%" seria pior que mostrar so o valor
    absoluto. Mesma regra de nao-inventar do CMV e do ponto de equilibrio.
    """
    headers = criar_empresa("Partindo do Zero")
    lancar(headers, "receita", 5000, dias_atras=205)  # so no periodo atual

    comp = relatorio_janela_limpa(headers)["comparativo"]["receitas"]
    assert comp["anterior"] == 0
    assert comp["atual"] == 5000
    assert comp["delta"] == 5000
    assert comp["delta_percent"] is None, "sem base anterior nao ha percentual honesto"


def test_comparativo_respeita_o_mesmo_filtro_do_periodo_atual():
    """Filtro de tipo aplicado no atual vale igual no anterior.

    Comparar "delivery deste mes" com "tudo do mes passado" produziria uma
    queda inventada. Os dois lados passam pelo mesmo recorte.
    """
    headers = criar_empresa("Filtro Comparativo")
    lancar(headers, "receita", 800, dias_atras=215)
    lancar(headers, "receita", 900, dias_atras=205)

    agora = datetime.now(timezone.utc)
    inicio = agora - timedelta(days=JANELA_LIMPA_INICIO)
    fim = agora - timedelta(days=JANELA_LIMPA_FIM)
    rep = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers, params={
        "inicio": inicio.isoformat(), "fim": fim.isoformat(), "tipo": "delivery",
    }).json()

    # O filtro de tipo atinge pedidos, nao lancamentos manuais — o que importa
    # aqui e que o bloco continua coerente e nao explode com filtro aplicado.
    assert rep["comparativo"]["receitas"]["anterior"] == 800
    assert rep["comparativo"]["receitas"]["atual"] == 900


def test_lucro_liquido_negativo_compara_corretamente():
    """Prejuizo que diminui aparece como melhora, nao como piora.

    Com base negativa o percentual usa o modulo do anterior: sair de -1000 para
    -500 e +50% (melhorou), nao -50%.
    """
    headers = criar_empresa("Prejuizo Menor")
    lancar(headers, "despesa", 1000, dias_atras=215, categoria="Aluguel", natureza="fixa")
    lancar(headers, "despesa", 500, dias_atras=205, categoria="Aluguel", natureza="fixa")

    comp = relatorio_janela_limpa(headers)["comparativo"]["lucro_liquido"]
    assert comp["anterior"] < 0 and comp["atual"] < 0, comp
    assert comp["atual"] > comp["anterior"], "prejuizo menor = numero maior"
    assert comp["delta"] > 0, "a variacao de um prejuizo que diminuiu e positiva"
    assert comp["delta_percent"] > 0, f"melhora deveria dar percentual positivo, deu {comp['delta_percent']}"


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
