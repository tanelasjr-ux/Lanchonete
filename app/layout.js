import './globals.css'
import { Providers } from './providers'

export const metadata = {
  title: 'Restaurant OS — Plataforma de Gestão para Restaurantes',
  description: 'SaaS multi-tenant para gestão completa de restaurantes: cardápio, pedidos, clientes, financeiro e integrações WhatsApp/automação.',
  // Faz o iOS abrir em tela cheia quando o site e adicionado a tela inicial —
  // no iPhone e isto (nao o manifest) que remove as barras do Safari.
  appleWebApp: {
    capable: true,
    title: 'Restaurant OS',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
}

/**
 * `viewport-fit: cover` deixa o app usar a area sob o notch e a barra de
 * gestos; sem ele o iOS reserva faixas pretas. O `globals.css` compensa com
 * `env(safe-area-inset-*)` para nada de clicavel ficar embaixo do recorte.
 *
 * `maximumScale`/`userScalable` NAO sao restringidos de proposito: travar o
 * zoom quebra a acessibilidade de quem precisa aumentar a fonte, e o preco
 * (o iOS dar zoom ao focar um input) ja esta resolvido pelo `font-size: 16px`
 * nos campos, em globals.css.
 */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/* O Next ja emite `mobile-web-app-capable` (o nome padronizado) a
            partir de `metadata.appleWebApp`. Esta linha repete a versao com
            prefixo `apple-`, que iOS mais antigos ainda exigem para abrir em
            tela cheia — sem ela, nesses aparelhos o atalho abriria dentro do
            Safari, com as barras que o dono pediu para tirar. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <script dangerouslySetInnerHTML={{__html:'window.addEventListener("error",function(e){if(e.error instanceof DOMException&&e.error.name==="DataCloneError"&&e.message&&e.message.includes("PerformanceServerTiming")){e.stopImmediatePropagation();e.preventDefault()}},true);'}} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
