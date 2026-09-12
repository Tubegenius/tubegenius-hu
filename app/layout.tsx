import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'WillViral — Creator Operating System',
  description: 'A következő videód itt kezdődik.',
  icons: {
    icon: '/brand/favicon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="hu">
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />
      </head>
      <body className="bg-background text-text-primary antialiased">
        {children}
      </body>
    </html>
  )
}
