import './globals.css'
import { Providers } from './providers'

export const metadata = {
  title: 'Restaurant OS — Plataforma de Gestão para Restaurantes',
  description: 'SaaS multi-tenant para gestão completa de restaurantes: cardápio, pedidos, clientes, financeiro e integrações WhatsApp/automação.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{__html:'window.addEventListener("error",function(e){if(e.error instanceof DOMException&&e.error.name==="DataCloneError"&&e.message&&e.message.includes("PerformanceServerTiming")){e.stopImmediatePropagation();e.preventDefault()}},true);'}} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
