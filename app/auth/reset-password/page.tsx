'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'

const NEUTRAL_SUCCESS_MESSAGE = 'Ha létezik fiók ezzel az email-címmel, elküldtük a jelszó-visszaállító linket.'
const RATE_LIMIT_MESSAGE = 'Túl sok próbálkozás történt röviden időn belül. Kérjük, várj néhány percet, mielőtt újra próbálkozol.'
const GENERIC_ERROR_MESSAGE = 'Valami hiba történt. Próbáld újra.'

function isRateLimitError(status: number | undefined, message: string | undefined): boolean {
  return status === 429 || Boolean(message && /rate.?limit/i.test(message))
}

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('')
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)

    const supabase = createClient()
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/recovery`,
    })

    if (!isMountedRef.current) return
    setLoading(false)

    if (resetError && isRateLimitError(resetError.status, resetError.message)) {
      setError(RATE_LIMIT_MESSAGE)
      return
    }

    if (resetError) {
      setError(GENERIC_ERROR_MESSAGE)
      return
    }

    setSuccess(true)
  }

  if (success) {
    return (
      <div className="card text-center">
        <div className="w-12 h-12 rounded-full bg-emerald/10 border border-emerald/20 flex items-center justify-center mx-auto mb-4">
          <span className="text-emerald text-xl">✓</span>
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">Email elküldve</h2>
        <p className="text-text-secondary text-sm mb-6">{NEUTRAL_SUCCESS_MESSAGE}</p>
        <Link href="/auth/login" className="btn-secondary inline-block">
          Vissza a belépéshez
        </Link>
      </div>
    )
  }

  return (
    <div className="card">
      <h1 className="text-2xl font-semibold text-text-primary mb-1">Jelszó visszaállítása</h1>
      <p className="text-text-secondary text-sm mb-8">
        Add meg az email-címed, és küldünk egy linket az új jelszó beállításához.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
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
          {loading ? 'Küldés...' : 'Visszaállító link küldése'}
        </button>
      </form>

      <div className="mt-6 pt-6 border-t border-border text-center">
        <p className="text-text-muted text-sm">
          Eszedbe jutott a jelszavad?{' '}
          <Link href="/auth/login" className="text-violet hover:text-violet-glow transition-colors font-medium">
            Lépj be
          </Link>
        </p>
      </div>
    </div>
  )
}
