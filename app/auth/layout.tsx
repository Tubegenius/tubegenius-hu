import Logo from '@/components/brand/Logo'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="wv-auth-shell">
      <div className="wv-auth-grid" aria-hidden="true" />
      <div className="wv-auth-frame">
        <div className="wv-auth-brand">
          <Logo variant="full" size="lg" />
          <p>Creator Intelligence OS</p>
        </div>

        {children}
      </div>
    </div>
  )
}
