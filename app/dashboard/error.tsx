'use client'

import { Link2Off, RotateCcw } from 'lucide-react'

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="wv-error-state" role="alert">
      <span className="wv-error-stitch" aria-hidden="true"><Link2Off /></span>
      <div>
        <span className="wv-eyebrow">A projekted biztonságban maradt</span>
        <h1>Egy kapcsolat most megszakadt.</h1>
        <p>Az alkotói munkád nem veszett el. Próbáld újra ezt a felületi lépést; ha a kapcsolat még nem állt helyre, később ugyaninnen folytathatod.</p>
      </div>
      <button type="button" className="wv-primary-button" onClick={reset}><RotateCcw aria-hidden="true" />Újrapróbálom</button>
    </section>
  )
}
