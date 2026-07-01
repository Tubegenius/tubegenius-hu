'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError('Hibás email vagy jelszó.')
      setLoading(false)
      return
    }

    window.location.replace('http://localhost:3000/dashboard')
  }

  return (
    <div className="card">
      <h1 className="text-2xl font-semibold text-text-primary mb-1">Belépés</h1>
      <p className="text-text-secondary text-sm mb-8">
        Folytasd ott ahol abbahagytad.
      </p>

      <form onSubmit={handleLogin} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="te@example.com"
            required
            className="input"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium text-text-secondary">Jelszó</label>
            <Link href="/auth/reset-password" className="text-xs text-violet hover:text-violet-glow transition-colors">
              Elfelejtettem
            </Link>
          </div>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            className="input"
          />
        </div>

        {error && (
          <div className="bg-rose/10 border border-rose/20 rounded-lg px-4 py-3 text-rose text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full"
        >
          {loading ? 'Belépés...' : 'Belépés'}
        </button>
      </form>

      <div className="mt-6 pt-6 border-t border-border text-center">
        <p className="text-text-muted text-sm">
          Még nincs fiókod?{' '}
          <Link href="/auth/register" className="text-violet hover:text-violet-glow transition-colors font-medium">
            Regisztrálj ingyen
          </Link>
        </p>
      </div>
    </div>
  )
}
