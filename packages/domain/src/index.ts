/**
 * @restaurant-os/domain
 * ---------------------------------------------------------------------------
 * Camada de dominio (DDD) compartilhada. Entidades e contratos de repositorio
 * independentes de framework/infra. Implementacoes concretas (Mongo/Supabase)
 * satisfazem estas interfaces (Repository Pattern + Dependency Inversion).
 */

export type UUID = string;
export type Papel = 'OWNER' | 'ADMIN' | 'GERENTE' | 'ATENDENTE' | 'COZINHA';
/**
 * Dois vocabularios convivem hoje (nao normalizados pelo app - ver
 * normPedidoStatus() em route.js): o minusculo original ('recebido'..'cancelado')
 * e um maiusculo introduzido no v3 para o fluxo de atendimento/delivery
 * ('NOVO'..'CANCELADO'). PUT /pedidos aceita ambos sem conversao.
 */
export type PedidoStatus =
  | 'recebido' | 'em_preparo' | 'pronto' | 'concluido' | 'cancelado' | 'saiu_para_entrega'
  | 'NOVO' | 'CONFIRMADO' | 'EM_PREPARACAO' | 'PRONTO' | 'SAIU_PARA_ENTREGA' | 'ENTREGUE' | 'CANCELADO';
/**
 * Como o pedido chega ao cliente. Tres valores desde a migration 0024 — antes
 * eram quatro (`balcao` e `retirada` descreviam a mesma situacao e foram
 * fundidos em `para_levar`, com o historico reclassificado).
 *
 * `mesa` nao e criado pelo dialogo de Novo Pedido: nasce quando uma comanda e
 * fechada (ver route.js, fechamento de comanda). Atendimento em mesa comeca
 * sempre pela tela de Mesas.
 */
export type PedidoTipo = 'delivery' | 'mesa' | 'para_levar';
export type Pagamento = 'pix' | 'cartao' | 'dinheiro';
export type TransacaoTipo = 'receita' | 'despesa';
export type IntegracaoTipo = 'evolution' | 'n8n' | 'mercadopago';
export type IntegracaoStatus = 'nao_configurado' | 'configurado';
export type MesaStatus = 'livre' | 'ocupada' | 'aguardando_pagamento' | 'reservada';
export type ComandaStatus = 'aberta' | 'fechada';
export type DescontoTipo = 'valor' | 'percent';
export type ConversaStatus = 'ABERTA' | 'AGUARDANDO_EQUIPE' | 'AGUARDANDO_CLIENTE' | 'RESOLVIDA';
export type MensagemDirecao = 'in' | 'out';
/** 'conversation' e o messageType bruto da Evolution API para texto simples (nao e bug). */
export type MensagemTipo = 'text' | 'image' | 'audio' | 'document' | 'conversation';
export type PagamentoProvider = 'manual' | 'mercadopago';
export type CaixaStatus = 'aberto' | 'fechado';
export type CaixaMovimentoTipo = 'sangria' | 'suprimento';

/** Marcador de multitenancy: toda entidade de dominio carrega empresa_id. */
export interface TenantScoped {
  empresa_id: UUID;
}

/**
 * Modulos contratados pela empresa (ver docs/ARCHITECTURE.md ADR-005).
 *
 * Desde 2026-08-18 estas flags CONTROLAM ACESSO DE VERDADE: `mesas`,
 * `comandas`, `estoque` e `caixa` sao lidas pelo portao em route.js e
 * `false` devolve 403. Antes disso eram decorativas — existiam, apareciam na
 * tela, e nenhum endpoint as consultava.
 *
 * Regra de leitura (implementada uma unica vez em lib/modulos.js): so `false`
 * explicito desliga. Ausente/null conta como LIGADO, para que falta de dado
 * nunca tire acesso de quem ja usa o modulo.
 *
 * As demais continuam sem implementacao: aparecem como "Em breve" e nao tem
 * interruptor, porque ligar o que nao existe reproduziria a mentira original.
 */
export interface EmpresaFeatureFlags {
  mesas: boolean; comandas: boolean; estoque: boolean; crm: boolean;
  campanhas: boolean; fidelidade: boolean; cashback: boolean; billing: boolean;
  caixa: boolean; multiunidade: boolean;
}

export interface EmpresaAppearance {
  cor_principal: string; cor_secundaria: string; tema: 'light' | 'dark'; nome_exibido: string;
}

export interface EmpresaPagamentosConfig {
  metodos: { dinheiro: boolean; pix: boolean; cartao_debito: boolean; cartao_credito: boolean };
  taxa_servico_padrao: number;
}

export interface EmpresaDeliveryConfig {
  taxa_padrao: number;
  tempo_estimado_min: number | null;
}

export interface EmpresaConfig {
  feature_flags: EmpresaFeatureFlags;
  appearance: EmpresaAppearance;
  pagamentos: EmpresaPagamentosConfig;
  delivery?: EmpresaDeliveryConfig;
}

export interface Empresa {
  id: UUID;
  nome: string;
  slug: string;
  plano: string;
  telefone: string;
  endereco: string;
  moeda: string;
  nome_comercial: string;
  cnpj: string;
  whatsapp: string;
  email: string;
  logo: string | null;
  cardapio_imagem_url: string | null;
  horario_funcionamento: string;
  config: EmpresaConfig;
  ativo: boolean;
  created_at: string;
}

export interface Usuario extends TenantScoped {
  id: UUID;
  nome: string;
  email: string;
  papel: Papel;
  ativo: boolean;
  created_at: string;
}

export interface Categoria extends TenantScoped {
  id: UUID; nome: string; ordem: number; ativo: boolean;
}

export interface Produto extends TenantScoped {
  id: UUID; categoria_id: UUID | null; nome: string; descricao: string;
  preco: number; imagem: string | null; disponivel: boolean; ativo: boolean;
  estoque_habilitado: boolean;
  estoque_quantidade: number | null;
  estoque_minimo: number;
  /**
   * Custo unitario. `null` = nao cadastrado: fica fora do CMV e conta contra
   * a cobertura. `0` = custo zero real (brinde, cortesia) e entra no calculo.
   * A distincao e o que impede o CMV de mentir para baixo.
   */
  custo: number | null;
}

export interface Cliente extends TenantScoped {
  id: UUID; nome: string; telefone: string; email: string; endereco: string;
  observacoes: string; total_pedidos: number; total_gasto: number;
}

export interface EstoqueAjuste {
  produto_id: UUID;
  empresa_id: UUID;
  quantidade_anterior: number;
  quantidade_nova: number;
  motivo: string; // 'venda', 'devolucao', 'ajuste_manual', 'sucata'
  usuario_id: UUID;
  data: Date;
}

export interface Entregador extends TenantScoped {
  id: UUID; nome: string; telefone: string; ativo: boolean; created_at: string;
}

/**
 * `preco` e `nome` sao um snapshot no momento da venda — nunca recalculados a
 * partir do produto atual. Se o produto mudar de preco depois, pedidos e
 * comandas antigos devem preservar o valor original (decisao do dono do
 * projeto na migracao Mongo->Supabase, 2026-08-09).
 */
export interface PedidoItem {
  id: UUID; pedido_id: UUID; produto_id: UUID | null;
  nome: string; preco: number; quantidade: number;
  desconto: number; observacao: string; subtotal: number;
  created_at: string;
}

export interface ComandaItem {
  id: UUID; comanda_id: UUID; produto_id: UUID | null;
  nome: string; preco: number; quantidade: number;
  desconto: number; observacao: string; subtotal: number;
  operador_id: UUID | null; operador_nome: string | null;
  created_at: string;
  /** Marcado pelo atendente (celular) ou pela TV em modo toque quando o item sai da cozinha. */
  entregue: boolean;
}

export interface Pedido extends TenantScoped {
  id: UUID; numero: number; cliente_id: UUID | null; cliente_nome: string;
  itens: PedidoItem[]; tipo: PedidoTipo; pagamento: Pagamento;
  status: PedidoStatus; observacoes: string;
  /**
   * Valores. Mesma gramatica de `Comanda`: `total = subtotal - desconto +
   * acrescimo`, sempre calculado no Service (nunca em trigger). `desconto` e
   * `acrescimo` sao ajustes manuais do operador — cortesia, arredondamento,
   * taxa de entrega, acerto pontual. Pedidos anteriores a migration 0015 tem
   * `subtotal = total` e os ajustes zerados.
   */
  subtotal: number; desconto: number; acrescimo: number; total: number;
  /** Preenchido quando o pedido nasce do fechamento de uma comanda. */
  comanda_id?: UUID | null;
  /** Campos de delivery (migration 0017). */
  entrega_endereco: string; entrega_taxa: number; entrega_tempo_estimado_min: number | null;
  entregador_id: UUID | null; entregador_nome: string; saiu_para_entrega_em: string | null;
  created_at: string; updated_at: string;
}

export interface Transacao extends TenantScoped {
  id: UUID; tipo: TransacaoTipo; categoria: string; descricao: string;
  valor: number; pedido_id: UUID | null; comanda_id: UUID | null; data: string;
  /**
   * Metodo desta transacao ('pix' | 'cartao' | 'dinheiro'). Transacoes
   * anteriores a migration 0018 tem string vazia — nao ha dado de onde
   * inferir o metodo, e inventar um falsearia a auditoria.
   */
  forma_pagamento: string;
  /** Caixa em que a venda entrou. Nulo quando nao havia caixa aberto. */
  caixa_id: UUID | null;
  /**
   * Custo apurado no momento da venda. Congelado: mudar o custo do produto
   * amanha nao reescreve o CMV de hoje. Transacoes anteriores a migration
   * 0020 tem 0 — nao ha dado de onde inferir o custo, e inventar um falsearia
   * o indicador.
   */
  custo_total: number;
  /** Receita dos itens que tinham custo. Denominador do CMV. */
  receita_com_custo: number;
  /** Receita de TODOS os itens. Denominador da cobertura. */
  receita_base: number;
  /**
   * Natureza da despesa para o DRE/ponto de equilibrio (migration 0022).
   * `null` = nao classificada (inclui toda transacao anterior a 0022, e
   * receitas — o campo so tem sentido para tipo='despesa'). Nunca inferida a
   * partir da categoria no servidor: mesma regra de "nao adivinhar" de
   * `custo_total`/`cardapio_imagem_url` — ver lib/financeiro.js.
   */
  natureza: 'fixa' | 'variavel' | null;
}

/**
 * Conta a pagar/receber — camada de OBRIGACAO (migration 0025), complementar
 * a `Transacao` (a camada de CAIXA). So passa a valer para o relatorio
 * financeiro quando marcada como paga, o que cria a `Transacao`
 * correspondente e preenche `transacao_id` — antes disso a conta e so uma
 * previsao, invisivel para DRE/CMV/margem.
 */
export interface Conta extends TenantScoped {
  id: UUID;
  tipo: 'pagar' | 'receber';
  descricao: string;
  categoria: string;
  /** So relevante para `tipo: 'pagar'`. Nunca inferida — mesma regra de Transacao.natureza. */
  natureza: 'fixa' | 'variavel' | null;
  valor: number;
  /** Data (nao instante) do vencimento — formato `YYYY-MM-DD`. */
  vencimento: string;
  /**
   * `'atrasada'` NUNCA e gravado aqui — so existe como valor calculado na
   * leitura (`statusEfetivo` em lib/contas.js), a partir de `vencimento` e
   * `status === 'pendente'`. O contrato grava so os tres estados reais.
   */
  status: 'pendente' | 'paga' | 'cancelada';
  pago_em: string | null;
  /** Preenchido so quando `status === 'paga'`. */
  transacao_id: UUID | null;
  observacoes: string;
  created_at: string;
  updated_at: string;
}

/**
 * Sessao de caixa. Um caixa aberto por empresa por vez — garantido por
 * indice unico parcial no Postgres, nao so pela checagem na aplicacao.
 */
export interface Caixa extends TenantScoped {
  id: UUID;
  status: CaixaStatus;
  aberto_por: UUID | null;
  aberto_por_nome: string;
  aberto_em: string;
  /** Fundo de troco colocado na gaveta na abertura. */
  valor_abertura: number;
  fechado_por: UUID | null;
  fechado_por_nome: string;
  fechado_em: string | null;
  /** O que foi contado fisicamente na gaveta. Nulo enquanto aberto. */
  valor_contado: number | null;
  /** O que o Service calculou. Nulo enquanto aberto. */
  valor_esperado: number | null;
  /** `valor_contado - valor_esperado`. Positivo e sobra, negativo e falta. */
  diferenca: number | null;
  observacoes: string;
  created_at: string;
}

/**
 * Movimento de gaveta que NAO e venda. Sangria leva dinheiro ao cofre,
 * suprimento traz troco. Nenhum dos dois e receita ou despesa — por isso
 * vivem aqui e nunca em `transacoes`.
 */
export interface CaixaMovimento extends TenantScoped {
  id: UUID;
  caixa_id: UUID;
  tipo: CaixaMovimentoTipo;
  valor: number;
  motivo: string;
  usuario_id: UUID | null;
  usuario_nome: string;
  created_at: string;
}

/** Trilha de auditoria: somente-leitura + append, nunca update/delete. */
export interface Auditoria extends TenantScoped {
  id: UUID; usuario_id: UUID | null; usuario_nome: string | null;
  acao: string; entidade: string; entidade_id: string | null;
  dados: Record<string, unknown>; created_at: string;
}

export interface EvolutionConfig { serverUrl: string; apiKey: string; instance: string }
export interface N8nConfig { webhookUrl: string; apiKey: string; eventos: string[] }
export interface MercadoPagoConfig { mode: 'sandbox' | 'production'; accessToken: string; webhookSecret: string }

/** Chave logica e (empresa_id, tipo), nao um `id` avulso. */
export interface Integracao extends TenantScoped {
  id: UUID; tipo: IntegracaoTipo;
  config: Partial<EvolutionConfig> | Partial<N8nConfig> | Partial<MercadoPagoConfig> | Record<string, never>;
  status: IntegracaoStatus; created_at: string; updated_at: string;
}

export interface Mesa extends TenantScoped {
  id: UUID; numero: number; nome: string; capacidade: number;
  status: MesaStatus; comanda_id: UUID | null; ativo: boolean;
  created_at: string; updated_at: string;
}

/** Resumo denormalizado de um pagamento, embutido no runtime de `Comanda.pagamentos`. */
export interface PagamentoResumo {
  id: UUID; metodo: string; valor: number; status: string;
  provider: PagamentoProvider; created_at: string;
}

export interface Comanda extends TenantScoped {
  id: UUID; mesa_id: UUID; mesa_nome: string;
  cliente_id: UUID | null; cliente_nome: string; pessoas: number;
  status: ComandaStatus; itens: ComandaItem[];
  /**
   * Lacuna encontrada na Fase 5 (auditoria de repositories): computeComanda()
   * no Service sempre leu este campo do objeto em memoria, mas ele nunca
   * tinha sido declarado aqui. No Mongo e um array embutido (fonte real);
   * no Postgres NAO existe coluna equivalente (decisao da Fase 4: pagamentos
   * e tabela propria, fonte unica) - o SupabaseComandaRepository reconstroi
   * este campo em memoria a partir da tabela `pagamentos` só para preservar
   * o contrato que o Service ja espera, sem alterar computeComanda().
   */
  pagamentos: PagamentoResumo[];
  desconto: number; desconto_tipo: DescontoTipo; taxa_servico_percent: number;
  operador_id: UUID; operador_nome: string;
  aberta_em: string; fechada_em: string | null;
  created_at: string; updated_at: string;
}

/**
 * Saida de `computeComanda()` (regra de negocio no Service, nunca em
 * trigger). subtotal/desconto_valor/taxa_valor/total/pago/restante sao
 * sempre derivados dos itens+pagamentos, nunca a fonte de verdade.
 */
export interface ComandaComputed {
  subtotal: number; desconto_valor: number; taxa_valor: number;
  total: number; pago: number; restante: number;
}

export type ComandaComDerivados = Comanda & ComandaComputed;

/**
 * Nome distinto de `Pagamento` (forma de pagamento: pix/cartao/dinheiro) para
 * evitar colisao com o registro de pagamento em si. Append-only (fonte de
 * verdade, sem delete fisico).
 */
export interface PagamentoRegistro extends TenantScoped {
  id: UUID; comanda_id: UUID | null; pedido_id: UUID | null;
  metodo: string; valor: number; status: string; provider: PagamentoProvider;
  provider_payment_id: string | null; external_reference: string | null;
  idempotency_key: string;
  qr_code?: string; qr_code_base64?: string; ticket_url?: string | null;
  created_at: string; updated_at: string;
}

export interface Conversa extends TenantScoped {
  id: UUID; cliente_id: UUID | null; contato_nome: string; contato_numero: string;
  status: ConversaStatus; ultima_mensagem: string; ultima_mensagem_em: string;
  nao_lidas: number; operador_id: UUID | null; pedido_ativo_id: UUID | null;
  created_at: string; updated_at: string;
}

/** Log de mensagens imutavel: sem update/delete, so create + list. */
export interface Mensagem extends TenantScoped {
  id: UUID; conversa_id: UUID; direcao: MensagemDirecao; tipo: MensagemTipo;
  texto: string; media_url: string | null; from_me: boolean;
  status: string; provider_message_id: string | null;
  operador_id: UUID | null; created_at: string;
}

/** Contrato generico de repositorio, sempre escopado por tenant. */
export interface Repository<T extends TenantScoped> {
  list(empresaId: UUID, filter?: Partial<T>): Promise<T[]>;
  findById(empresaId: UUID, id: UUID): Promise<T | null>;
  create(entity: T): Promise<T>;
  update(empresaId: UUID, id: UUID, patch: Partial<T>): Promise<T | null>;
  delete(empresaId: UUID, id: UUID): Promise<void>;
}

/**
 * Bulk insert. Existe porque o seed de demonstracao (`seedEmpresa()` em
 * route.js) cria varias entidades de uma vez; ate a Fase 6 isso era feito com
 * `db.collection().insertMany()` direto, fora do contrato. A Fase 7 (switch de
 * provider) precisou abstrair esse acesso para que o runtime Supabase nao
 * dependesse do Mongo so para o seed. Nao substitui `create()`: e uma
 * operacao de carga, sem retorno das entidades criadas.
 */
export interface BulkCreatable<T> {
  createMany(entities: T[]): Promise<void>;
}

export interface ProdutoRepository extends Repository<Produto>, BulkCreatable<Produto> {
  /** Cascade usado ao excluir uma categoria (route.js). */
  deleteManyByCategoria(empresaId: UUID, categoriaId: UUID): Promise<void>;

  decrementarEstoque(empresaId: UUID, produtoId: UUID, quantidade: number, motivo: string): Promise<Produto>;
  ajustarEstoque(empresaId: UUID, produtoId: UUID, novaQuantidade: number, motivo: string): Promise<Produto>;
  listEstoqueBaixo(empresaId: UUID): Promise<Produto[]>;
  getEstoque(empresaId: UUID, produtoId: UUID): Promise<number | null>;
}
export interface CategoriaRepository extends Repository<Categoria>, BulkCreatable<Categoria> {}
export interface ClienteRepository extends Repository<Cliente>, BulkCreatable<Cliente> {
  /** Usado pelo webhook do WhatsApp para achar/criar cliente pelo numero. */
  findByTelefone(empresaId: UUID, telefone: string): Promise<Cliente | null>;
  /** Disparado ao concluir pedido/fechar comanda (nao e recalculo, e incremento). */
  incrementarMetricasPedido(empresaId: UUID, id: UUID, valor: number): Promise<void>;
  /** Usado no dashboard (totalClientes) sem precisar carregar a lista inteira. */
  count(empresaId: UUID): Promise<number>;
}
export interface EntregadorRepository extends Repository<Entregador>, BulkCreatable<Entregador> {}
export interface PedidoRepository extends Repository<Pedido>, BulkCreatable<Pedido> {
  /** numero sequencial por empresa; nao atomico hoje (count+1), ver auditoria. */
  nextNumero(empresaId: UUID): Promise<number>;
  /** GET /pedidos: mais recentes primeiro, com limite. */
  listRecentes(empresaId: UUID, filter: Partial<Pedido>, limit: number): Promise<Pedido[]>;
  /** Usado na Central de Atendimento para achar o pedido ativo do cliente. */
  findByCliente(empresaId: UUID, clienteId: UUID): Promise<Pedido[]>;
}
export interface TransacaoRepository extends Repository<Transacao>, BulkCreatable<Transacao> {
  /** GET /financeiro/transacoes: mais recentes primeiro, com limite. */
  listRecentes(empresaId: UUID, limit: number): Promise<Transacao[]>;
  findByCaixa(empresaId: UUID, caixaId: UUID): Promise<Transacao[]>;
  findByPedido(empresaId: UUID, pedidoId: UUID): Promise<Transacao[]>;
}

export interface ContaRepository {
  create(entity: Conta): Promise<Conta>;
  findById(empresaId: UUID, id: UUID): Promise<Conta | null>;
  /** Lista completa da empresa, ordenada por vencimento — a UI filtra em memoria. */
  list(empresaId: UUID): Promise<Conta[]>;
  update(empresaId: UUID, id: UUID, patch: Partial<Conta>): Promise<Conta>;
}

export interface CaixaRepository extends Repository<Caixa> {
  findAberto(empresaId: UUID): Promise<Caixa | null>;
  listarFechados(empresaId: UUID, limite?: number): Promise<Caixa[]>;
}

export interface CaixaMovimentoRepository extends Repository<CaixaMovimento> {
  listByCaixa(empresaId: UUID, caixaId: UUID): Promise<CaixaMovimento[]>;
}

/** Empresa e a raiz do tenant: nao tem empresa_id proprio, nao usa Repository<T>. */
export interface EmpresaRepository {
  findById(id: UUID): Promise<Empresa | null>;
  findBySlug(slug: string): Promise<Empresa | null>;
  create(empresa: Empresa): Promise<Empresa>;
  update(id: UUID, patch: Partial<Empresa>): Promise<Empresa | null>;
}

export interface UsuarioRepository extends Repository<Usuario> {
  /** Email e unico globalmente (nao por empresa) por decisao de produto existente. */
  findByEmail(email: string): Promise<Usuario | null>;
}

/** Append-only + leitura; sem update/delete. */
export interface AuditoriaRepository {
  list(empresaId: UUID, limit?: number): Promise<Auditoria[]>;
  registrar(entry: Omit<Auditoria, 'id' | 'created_at'>): Promise<Auditoria>;
}

/** Chave e (empresaId, tipo) em vez de id — sempre upsert. */
export interface IntegracaoRepository extends BulkCreatable<Integracao> {
  list(empresaId: UUID): Promise<Integracao[]>;
  findByTipo(empresaId: UUID, tipo: IntegracaoTipo): Promise<Integracao | null>;
  upsert(empresaId: UUID, tipo: IntegracaoTipo, patch: Partial<Pick<Integracao, 'config' | 'status'>>): Promise<Integracao>;
}

export interface MesaRepository extends Repository<Mesa> {
  /** POST /mesas/configurar cria N mesas de uma vez. */
  createMany(entities: Mesa[]): Promise<void>;
  /**
   * Sincroniza o status da mesa a partir do saldo da comanda (reloadComanda),
   * mas nunca reabre uma mesa que ja foi liberada (status <> 'livre' e guarda,
   * nao uma condicao de negocio nova).
   */
  syncStatusOcupada(empresaId: UUID, mesaId: UUID, status: MesaStatus): Promise<void>;
}

/**
 * Repositorio fino, igual aos demais - SEM logica de negocio (sem recalculo,
 * sem orquestrar pedido/transacao/mesa). Quem decide "o que" e "quando"
 * escrever continua sendo o Service (route.js); estes metodos so descrevem
 * as operacoes de baixo nivel no array `itens`/`pagamentos` que vao alem do
 * CRUD generico de Repository<T> (nao existe equivalente a $push/$pull/
 * atualizacao posicional no contrato base).
 */
export interface ComandaRepository extends Repository<Comanda> {
  pushItem(empresaId: UUID, comandaId: UUID, item: ComandaItem): Promise<void>;
  updateItemCampos(empresaId: UUID, comandaId: UUID, itemId: UUID, patch: Partial<Pick<ComandaItem, 'quantidade' | 'observacao' | 'entregue'>>): Promise<void>;
  removeItem(empresaId: UUID, comandaId: UUID, itemId: UUID): Promise<void>;
  /** $push no array `pagamentos` (copia denormalizada - ver auditoria: duplica dado do PagamentoRepository). */
  pushPagamentoResumo(empresaId: UUID, comandaId: UUID, resumo: PagamentoResumo): Promise<void>;
  /** Persiste os campos ja computados por computeComanda() no Service - nunca recalcula aqui. */
  setDerivados(empresaId: UUID, comandaId: UUID, derivados: ComandaComputed): Promise<void>;
  /** GET /mesas: batch-fetch das comandas abertas para montar o resumo por mesa. */
  findManyByIds(empresaId: UUID, ids: UUID[]): Promise<Comanda[]>;
}

export interface PagamentoRepository extends Repository<PagamentoRegistro> {
  findByProviderPaymentId(empresaId: UUID, provider: PagamentoProvider, providerPaymentId: string): Promise<PagamentoRegistro | null>;
  /** Webhook assinado do Mercado Pago: unico ponto que atualiza status por provider_payment_id em vez de id. */
  atualizarStatusPorProviderPaymentId(empresaId: UUID, provider: PagamentoProvider, providerPaymentId: string, status: string): Promise<void>;
}

export interface ConversaRepository extends Repository<Conversa>, BulkCreatable<Conversa> {
  findByContatoNumero(empresaId: UUID, contatoNumero: string): Promise<Conversa | null>;
  /** Webhook do WhatsApp: nova mensagem numa conversa ja existente (nao e recalculo, e incremento). */
  incrementarNaoLidas(empresaId: UUID, id: UUID, patch: Partial<Conversa>): Promise<void>;
}

/** Log imutavel: so create + list, sem update/delete. */
export interface MensagemRepository extends BulkCreatable<Mensagem> {
  list(empresaId: UUID, conversaId: UUID): Promise<Mensagem[]>;
  create(mensagem: Omit<Mensagem, 'id' | 'created_at'>): Promise<Mensagem>;
}

/** Provedor de autenticacao desacoplado (JWT local | Supabase Auth). */
export interface AuthProvider {
  signIn(email: string, senha: string): Promise<{ token: string; usuario: Usuario }>;
  signUp(input: { empresa_nome: string; nome: string; email: string; senha: string }): Promise<{ token: string; usuario: Usuario; empresa: Empresa }>;
  verify(token: string): Promise<{ usuario_id: UUID; empresa_id: UUID; papel: Papel } | null>;
}
