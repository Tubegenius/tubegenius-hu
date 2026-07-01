export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      {/* Háttér gradient */}
      <div className="fixed inset-0 bg-violet-glow pointer-events-none" />
      
      {/* Subtle grid pattern */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(124,92,252,0.5) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(124,92,252,0.5) 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }}
      />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-violet flex items-center justify-center">
              <span className="text-white font-bold text-sm">W</span>
            </div>
            <span className="text-xl font-semibold text-text-primary">WillViral</span>
          </div>
          <p className="text-text-muted text-sm">Creator Intelligence Platform</p>
        </div>

        {children}
      </div>
    </div>
  )
}
