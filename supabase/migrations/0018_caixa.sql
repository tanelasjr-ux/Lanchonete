-- ============================================================================
-- Restaurant OS :: Migration 0018 :: Caixa (cash register, drawer)
-- ============================================================================
-- Gerenciamento de gaveta com sangria/suprimento.
-- Caixa: abertura/fechamento, sangria/suprimento, forma de pagamento na transacao.

CREATE TABLE public.caixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'aberto',
  aberto_por UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
  aberto_por_nome TEXT NOT NULL DEFAULT '',
  aberto_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valor_abertura NUMERIC(10,2) NOT NULL DEFAULT 0,
  fechado_por UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
  fechado_por_nome TEXT NOT NULL DEFAULT '',
  fechado_em TIMESTAMPTZ,
  valor_contado NUMERIC(10,2),
  valor_esperado NUMERIC(10,2),
  diferenca NUMERIC(10,2),
  observacoes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT caixas_status_valido CHECK (status IN ('aberto', 'fechado'))
);

-- Um unico caixa aberto por empresa. O indice parcial e a garantia real:
-- a checagem na aplicacao evita a mensagem feia, este indice evita a corrida.
CREATE UNIQUE INDEX caixas_um_aberto_por_empresa
  ON public.caixas (empresa_id) WHERE status = 'aberto';

CREATE INDEX caixas_empresa_status ON public.caixas (empresa_id, status);

ALTER TABLE public.caixas ENABLE ROW LEVEL SECURITY;
CREATE POLICY caixas_por_empresa ON public.caixas
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

CREATE TABLE public.caixa_movimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  caixa_id UUID NOT NULL REFERENCES public.caixas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  valor NUMERIC(10,2) NOT NULL,
  motivo TEXT NOT NULL DEFAULT '',
  usuario_id UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
  usuario_nome TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT caixa_movimentos_tipo_valido CHECK (tipo IN ('sangria', 'suprimento')),
  CONSTRAINT caixa_movimentos_valor_positivo CHECK (valor > 0)
);

CREATE INDEX caixa_movimentos_empresa_caixa
  ON public.caixa_movimentos (empresa_id, caixa_id);

ALTER TABLE public.caixa_movimentos ENABLE ROW LEVEL SECURITY;
CREATE POLICY caixa_movimentos_por_empresa ON public.caixa_movimentos
  FOR ALL USING (empresa_id = (SELECT empresa_id FROM public.usuarios WHERE id = auth.uid()));

ALTER TABLE public.transacoes
  ADD COLUMN forma_pagamento TEXT NOT NULL DEFAULT '',
  ADD COLUMN caixa_id UUID REFERENCES public.caixas(id) ON DELETE SET NULL;

CREATE INDEX transacoes_empresa_caixa ON public.transacoes (empresa_id, caixa_id);
