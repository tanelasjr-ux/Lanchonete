import os
import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000/api")

# Categorias que o seed de demonstracao usa para despesas aleatorias
# (route.js: seedEmpresa) e que NUNCA tem `natureza` — evitar nos testes para
# nao poluir uma soma que o teste confere com exatidao.
_CATEGORIAS_DO_SEED = {"Insumos", "Fornecedores", "Operacional"}


def criar_empresa(nome):
    """Cria empresa + usuario OWNER via /auth/register e devolve headers autenticados."""
    email = f"{nome.lower().replace(' ', '-')}-{os.urandom(4).hex()}@test.com"
    r = requests.post(f"{BASE_URL}/auth/register", json={
        "empresa_nome": nome, "nome": "Teste", "email": email, "senha": "senha123",
    })
    assert r.status_code == 200, f"registro falhou: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


def lancar(headers, tipo, categoria, valor, natureza=None):
    body = {"tipo": tipo, "categoria": categoria, "valor": valor}
    if natureza is not None:
        body["natureza"] = natureza
    r = requests.post(f"{BASE_URL}/financeiro/transacoes", headers=headers, json=body)
    assert r.status_code == 201, f"lancamento falhou: {r.status_code} {r.text}"
    return r.json()


def relatorio(headers):
    r = requests.get(f"{BASE_URL}/financeiro/relatorio", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_categorias_despesa_tem_natureza_sugerida():
    """GET /financeiro/categorias-despesa expoe o vocabulario fixo com natureza.

    Texto livre (como era ate 2026-08-18) deixava "Aluguel" e "aluguel" virarem
    categorias diferentes e nenhum agrupamento funcionar. Este endpoint alimenta
    o Select do dialog de lancamento manual.
    """
    headers = criar_empresa("Categorias Despesa")
    r = requests.get(f"{BASE_URL}/financeiro/categorias-despesa", headers=headers)
    assert r.status_code == 200
    cats = {c["valor"]: c["natureza_sugerida"] for c in r.json()}

    assert cats.get("Aluguel") == "fixa"
    assert cats.get("Pessoal") == "fixa"
    assert cats.get("Insumos") == "variavel"
    assert cats.get("Combustivel e Entrega") == "variavel"
    # "Outros" e "Estorno" nao tem natureza padrao: forcam o dono a decidir
    # (Estorno e gerado pelo sistema, nunca deveria aparecer no dialog manual).
    assert cats.get("Outros") is None


def test_transacao_persiste_natureza_valida():
    """POST /financeiro/transacoes grava a natureza enviada e a devolve."""
    headers = criar_empresa("Transacao Natureza")
    doc = lancar(headers, "despesa", "Aluguel", 1500, natureza="fixa")
    assert doc["natureza"] == "fixa"

    doc2 = lancar(headers, "despesa", "Combustivel e Entrega", 300, natureza="variavel")
    assert doc2["natureza"] == "variavel"


def test_transacao_sem_natureza_fica_null_nunca_inventada():
    """Sem `natureza` no corpo, o servidor grava null — nunca adivinha um valor.

    Mesma regra de nao-adivinhar de `produtos.custo` (migration 0020): um
    valor chutado seria pior que ausente, porque pareceria confiavel.
    """
    headers = criar_empresa("Transacao Sem Natureza")
    doc = lancar(headers, "despesa", "Marketing", 250)
    assert doc["natureza"] is None

    # Valor invalido tambem devolve null, nao um erro nem o valor invalido gravado.
    r = requests.post(f"{BASE_URL}/financeiro/transacoes", headers=headers,
                       json={"tipo": "despesa", "categoria": "Marketing", "valor": 10, "natureza": "chute"})
    assert r.status_code == 201
    assert r.json()["natureza"] is None


def test_dre_soma_fixas_e_variaveis_corretamente():
    """DRE separa despesas fixas de variaveis e calcula lucro liquido = lucro bruto - despesas."""
    headers = criar_empresa("DRE Somas")
    lancar(headers, "receita", "Vendas", 10000)
    lancar(headers, "despesa", "Aluguel", 1500, natureza="fixa")
    lancar(headers, "despesa", "Pessoal", 3000, natureza="fixa")
    lancar(headers, "despesa", "Combustivel e Entrega", 800, natureza="variavel")
    lancar(headers, "despesa", "Embalagens", 200, natureza="variavel")
    lancar(headers, "despesa", "Marketing", 100)  # nao classificada, de proposito

    dre = relatorio(headers)["dre"]
    assert dre["despesas_fixas"] == 4500
    assert dre["despesas_variaveis"] == 1000
    # >= e nao ==: o seed de demonstracao tambem gera despesa sem natureza.
    assert dre["despesas_nao_classificadas"] >= 100

    esperado_liquido = round(dre["lucro_bruto"] - dre["total_despesas_operacionais"], 2)
    assert abs(dre["lucro_liquido"] - esperado_liquido) < 0.01, \
        f"lucro_liquido ({dre['lucro_liquido']}) deveria ser lucro_bruto - despesas ({esperado_liquido})"


def test_ponto_equilibrio_calculavel_com_receita_e_despesa_fixa():
    """Com receita > 0 e despesa fixa cadastrada, ponto de equilibrio e um numero.

    Formula: despesas_fixas / margem_de_contribuicao, onde margem de
    contribuicao e a fracao de cada real vendido que sobra depois dos custos
    que escalam com a venda (mercadoria + despesa variavel).
    """
    headers = criar_empresa("Ponto Equilibrio Ok")
    lancar(headers, "receita", "Vendas", 20000)
    lancar(headers, "despesa", "Aluguel", 4000, natureza="fixa")
    lancar(headers, "despesa", "Combustivel e Entrega", 1000, natureza="variavel")

    dre = relatorio(headers)["dre"]
    assert dre["ponto_equilibrio"] is not None
    assert dre["ponto_equilibrio"] > 0

    # Confere a formula direto: margem = (receita - custo_variavel) / receita
    receita = dre["receita_total"]
    custo_variavel = dre["custo_mercadoria"] + dre["despesas_variaveis"]
    margem = (receita - custo_variavel) / receita
    esperado = round(dre["despesas_fixas"] / margem, 2)
    assert abs(dre["ponto_equilibrio"] - esperado) < 0.5, \
        f"ponto_equilibrio ({dre['ponto_equilibrio']}) nao bate com a formula ({esperado})"


def test_ponto_equilibrio_nulo_sem_despesa_fixa():
    """Sem despesa fixa, ponto de equilibrio e null — nunca 0 (0 seria mentira:
    diria que a operacao empata sem vender nada, que nao e o caso real, so
    ausencia de dado)."""
    headers = criar_empresa("Ponto Equilibrio Sem Fixa")
    lancar(headers, "receita", "Vendas", 5000)
    lancar(headers, "despesa", "Combustivel e Entrega", 200, natureza="variavel")

    dre = relatorio(headers)["dre"]
    assert dre["despesas_fixas"] == 0
    assert dre["ponto_equilibrio"] is None


def test_despesas_por_categoria_agrupa_e_marca_mista():
    """Duas transacoes na mesma categoria somam; naturezas diferentes na mesma
    categoria marcam 'mista' em vez de fingir consenso."""
    headers = criar_empresa("Despesas Por Categoria")
    lancar(headers, "despesa", "Manutencao", 100, natureza="fixa")
    lancar(headers, "despesa", "Manutencao", 50, natureza="fixa")

    rep = relatorio(headers)
    manutencao = next(c for c in rep["despesas_por_categoria"] if c["categoria"] == "Manutencao")
    assert manutencao["valor"] == 150
    assert manutencao["natureza"] == "fixa"

    # Mesma categoria, natureza divergente entre lancamentos -> 'mista'.
    lancar(headers, "despesa", "Manutencao", 30, natureza="variavel")
    rep2 = relatorio(headers)
    manutencao2 = next(c for c in rep2["despesas_por_categoria"] if c["categoria"] == "Manutencao")
    assert manutencao2["natureza"] == "mista"
    assert manutencao2["valor"] == 180


def test_dre_multitenant_isolado():
    """DRE de uma empresa nunca inclui despesa/receita lancada em outra."""
    headers_a = criar_empresa("DRE Multi A")
    headers_b = criar_empresa("DRE Multi B")

    lancar(headers_a, "despesa", "Aluguel", 9999, natureza="fixa")

    rep_b = relatorio(headers_b)
    aluguel_b = next((c for c in rep_b["despesas_por_categoria"] if c["categoria"] == "Aluguel"), None)
    assert aluguel_b is None or aluguel_b["valor"] != 9999, \
        "empresa B nao pode enxergar o lancamento de Aluguel da empresa A"
    assert rep_b["dre"]["despesas_fixas"] != 9999


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
