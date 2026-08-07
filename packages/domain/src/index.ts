/**
 * @restaurant-os/domain
 * ---------------------------------------------------------------------------
 * Camada de dominio (DDD) compartilhada. Entidades e contratos de repositorio
 * independentes de framework/infra. Implementacoes concretas (Mongo/Supabase)
 * satisfazem estas interfaces (Repository Pattern + Dependency Inversion).
 */

export type UUID = string;
export type Papel = 'OWNER' | 'ADMIN' | 'GERENTE' | 'ATENDENTE' | 'COZINHA';
export type PedidoStatus = 'recebido' | 'em_preparo' | 'pronto' | 'concluido' | 'cancelado';
export type PedidoTipo = 'balcao' | 'delivery' | 'retirada';
export type Pagamento = 'pix' | 'cartao' | 'dinheiro';
export type TransacaoTipo = 'receita' | 'despesa';

/** Marcador de multitenancy: toda entidade de dominio carrega empresa_id. */
export interface TenantScoped {
  empresa_id: UUID;
}

export interface Empresa {
  id: UUID;
  nome: string;
  slug: string;
  plano: string;
  telefone: string;
  endereco: string;
  moeda: string;
  config: Record<string, unknown>;
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
}

export interface Cliente extends TenantScoped {
  id: UUID; nome: string; telefone: string; email: string; endereco: string;
  observacoes: string; total_pedidos: number; total_gasto: number;
}

export interface PedidoItem {
  produto_id: UUID | null; nome: string; preco: number; quantidade: number;
}

export interface Pedido extends TenantScoped {
  id: UUID; numero: number; cliente_id: UUID | null; cliente_nome: string;
  itens: PedidoItem[]; tipo: PedidoTipo; pagamento: Pagamento;
  status: PedidoStatus; observacoes: string; total: number;
  created_at: string; updated_at: string;
}

export interface Transacao extends TenantScoped {
  id: UUID; tipo: TransacaoTipo; categoria: string; descricao: string;
  valor: number; pedido_id: UUID | null; data: string;
}

/** Contrato generico de repositorio, sempre escopado por tenant. */
export interface Repository<T extends TenantScoped> {
  list(empresaId: UUID, filter?: Partial<T>): Promise<T[]>;
  findById(empresaId: UUID, id: UUID): Promise<T | null>;
  create(entity: T): Promise<T>;
  update(empresaId: UUID, id: UUID, patch: Partial<T>): Promise<T | null>;
  delete(empresaId: UUID, id: UUID): Promise<void>;
}

export interface ProdutoRepository extends Repository<Produto> {}
export interface CategoriaRepository extends Repository<Categoria> {}
export interface ClienteRepository extends Repository<Cliente> {}
export interface PedidoRepository extends Repository<Pedido> {
  nextNumero(empresaId: UUID): Promise<number>;
}
export interface TransacaoRepository extends Repository<Transacao> {}

/** Provedor de autenticacao desacoplado (JWT local | Supabase Auth). */
export interface AuthProvider {
  signIn(email: string, senha: string): Promise<{ token: string; usuario: Usuario }>;
  signUp(input: { empresa_nome: string; nome: string; email: string; senha: string }): Promise<{ token: string; usuario: Usuario; empresa: Empresa }>;
  verify(token: string): Promise<{ usuario_id: UUID; empresa_id: UUID; papel: Papel } | null>;
}
