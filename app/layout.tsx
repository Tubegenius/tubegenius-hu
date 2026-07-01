import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'WillViral — Creator Intelligence Platform',
  description: 'Találd meg a következő sikeres videódat. Magyar créatoroknak.',
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
    <html lang="hu" className={inter.variable}>
      <head>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />
      </head>
      <body className="bg-background text-text-primary antialiased">
        {children}
      </body>
    </html>
  )
}
