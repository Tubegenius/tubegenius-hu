'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'

const GENERIC_ERROR_MESSAGE = 'Valami hiba történt. Próbáld újra.'

type SessionState = 'checking' | 'valid' | 'invalid'

export default function UpdatePasswordPage() {
  const [sessionState, setSessionState] = useState<SessionState>('checking')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!isMountedRef.current) return
      setSessionState(user ? 'valid' : 'invalid')
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
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
    const supabase = createClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (!isMountedRef.current) return
    setLoading(false)

    if (updateError) {
      setError(GENERIC_ERROR_MESSAGE)
      return
    }

    setSuccess(true)
  }

  if (sessionState === 'checking') {
    return (
      <div className="card text-center">
        <p className="text-text-secondary text-sm">Ellenőrzés...</p>
      </div>
    )
  }

  if (sessionState === 'invalid') {
    return (
      <div className="card text-center">
        <div className="w-12 h-12 rounded-full bg-rose/10 border border-rose/20 flex items-center justify-center mx-auto mb-4">
          <span className="text-rose text-xl">!</span>
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">A link érvénytelen vagy lejárt</h2>
        <p className="text-text-secondary text-sm mb-6">
          Kérj egy új jelszó-visszaállító linket.
        </p>
        <Link href="/auth/reset-password" className="btn-secondary inline-block">
          Új link kérése
        </Link>
      </div>
    )
  }

  if (success) {
    return (
      <div className="card text-center">
        <div className="w-12 h-12 rounded-full bg-emerald/10 border border-emerald/20 flex items-center justify-center mx-auto mb-4">
          <span className="text-emerald text-xl">✓</span>
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">Jelszó frissítve</h2>
        <p className="text-text-secondary text-sm mb-6">
          Az új jelszavad mostantól érvényes.
        </p>
        <Link href="/dashboard" className="btn-primary inline-block">
          Tovább a Dashboardra
        </Link>
      </div>
    )
  }

  return (
    <div className="card">
      <h1 className="text-2xl font-semibold text-text-primary mb-1">Új jelszó beállítása</h1>
      <p className="text-text-secondary text-sm mb-8">
        Add meg az új jelszavad kétszer.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            Új jelszó
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
          {loading ? 'Mentés...' : 'Jelszó mentése'}
        </button>
      </form>
    </div>
  )
}
