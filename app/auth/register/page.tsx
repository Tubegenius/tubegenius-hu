'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function RegisterPage() {
  const router = useRouter()
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('A két jelszó nem egyezik.')
      return
    }

    if (password.length < 8) {
      setError('A jelszó legalább 8 karakter legyen.')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    setSuccess(true)
    setLoading(false)
  }

  if (success) {
    return (
      <div className="card text-center">
        <div className="w-12 h-12 rounded-full bg-emerald/10 border border-emerald/20 flex items-center justify-center mx-auto mb-4">
          <span className="text-emerald text-xl">✓</span>
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">Ellenőrizd az emailed</h2>
        <p className="text-text-secondary text-sm mb-6">
          Küldtünk egy megerősítő emailt a <strong className="text-text-primary">{email}</strong> címre.
          Kattints a linkre a fiók aktiválásához.
        </p>
        <Link href="/auth/login" className="btn-secondary inline-block">
          Vissza a belépéshez
        </Link>
      </div>
    )
  }

  return (
    <div className="card">
      <h1 className="text-2xl font-semibold text-text-primary mb-1">Fiók létrehozása</h1>
      <p className="text-text-secondary text-sm mb-8">
        10 napos béta — ingyenes, kártyaadatok nélkül.
      </p>

      <form onSubmit={handleRegister} className="space-y-4">
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
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            Jelszó
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Min. 8 karakter"
            required
            className="input"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            Jelszó megerősítése
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
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
          {loading ? 'Regisztráció...' : 'Fiók létrehozása'}
        </button>
      </form>

      <p className="text-text-muted text-xs text-center mt-4">
        A regisztrációval elfogadod az{' '}
        <Link href="/terms" className="text-violet hover:underline">Általános Szerződési Feltételeket</Link>.
      </p>

      <div className="mt-6 pt-6 border-t border-border text-center">
        <p className="text-text-muted text-sm">
          Már van fiókod?{' '}
          <Link href="/auth/login" className="text-violet hover:text-violet-glow transition-colors font-medium">
            Lépj be
          </Link>
        </p>
      </div>
    </div>
  )
}
