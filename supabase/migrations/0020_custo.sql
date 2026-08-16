-- ============================================================================
-- Restaurant OS :: Migration 0020 :: Custo e Margem (CMV)
-- ============================================================================
-- Custo unitario do produto e apuracao congelada na transacao.
--
-- Por que o custo mora na transacao e nao no item: a transacao ja e a fonte
-- unica de verdade financeira e e criada por transacaoRepo.create() direto,
-- fora das funcoes atomicas create_pedido_com_itens()/create_comanda_com_itens(),
-- que usam lista explicita de colunas. Congelar aqui da precisao historica sem
-- tocar na parte mais fragil do schema.

-- NULL = nao cadastrado: fica fora do CMV e conta contra a cobertura.
-- 0 = custo zero real (brinde, cortesia) e ENTRA no calculo.
-- Sem essa distincao todo produto nasceria "de graca" e o CMV do primeiro dia
-- sairia lindo e falso.
alter table public.produtos
  add column if not exists custo numeric(12,2) default null
    check (custo is null or custo >= 0);

-- Congelado na venda: mudar o custo do produto amanha nao reescreve o CMV de
-- hoje. Transacoes anteriores a esta migration ficam em 0 e saem da conta
-- naturalmente, porque receita_com_custo = 0 (sem migracao retroativa).
alter table public.transacoes
  add column if not exists custo_total       numeric(12,2) not null default 0,
  add column if not exists receita_com_custo numeric(12,2) not null default 0,
  add column if not exists receita_base      numeric(12,2) not null default 0;
