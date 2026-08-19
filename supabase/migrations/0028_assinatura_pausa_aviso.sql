-- ============================================================================
-- Restaurant OS :: Migration 0028 :: Pausa do aviso de atraso (cortesia)
-- ============================================================================
-- Pedido do dono (2026-08-19): poder dar um mes de cortesia a um cliente
-- SEM apagar o atraso do proprio controle. Por isso isto NAO mexe em
-- `proximo_vencimento` nem em `status` — a assinatura continua atrasada de
-- verdade no Painel da Plataforma (conta em "valor em atraso"), so o AVISO
-- QUE O CLIENTE VE fica escondido ate a data escolhida.
--
-- Campo nullable e sem robo nenhum pra limpar: passada a data, a comparacao
-- em lib/assinatura.js simplesmente volta a considerar o campo "vencido",
-- entao o aviso reaparece sozinho no dia seguinte. Nao ha estado "pausa
-- ativa/inativa" para desatualizar.
alter table public.assinaturas
  add column if not exists aviso_pausado_ate date;
