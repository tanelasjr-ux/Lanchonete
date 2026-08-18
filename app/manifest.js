/**
 * Manifest do PWA — e o que permite "Adicionar a tela inicial" e, a partir
 * dali, abrir o sistema SEM a barra de endereco do navegador e sem a barra de
 * navegacao inferior (o dono reportou que as duas atrapalhavam no celular).
 *
 * `display: 'standalone'` e a peca que faz isso: o app abre numa janela
 * propria, com a aparencia de aplicativo instalado.
 *
 * Os icones sao gerados (chapeu de chef sobre o indigo da marca) e servem
 * para o sistema operacional montar o atalho. Nao confundir com a logo DA
 * EMPRESA (`empresas.logo`), que e por tenant e aparece dentro do app — o
 * icone do atalho e do produto, igual para todos os clientes.
 */
export default function manifest() {
  return {
    name: 'Restaurant OS',
    short_name: 'Restaurant OS',
    description: 'Gestao de restaurante: pedidos, mesas, cozinha, caixa e financeiro.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0a0a',
    theme_color: '#4f46e5',
    lang: 'pt-BR',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      // `maskable` deixa o Android recortar no formato do sistema (circulo,
      // squircle) sem cortar o desenho.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
