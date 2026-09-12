import Link from 'next/link'
import { ArrowUpRight, BookOpen, CalendarDays, FolderOpen, Search } from 'lucide-react'
import type { CreatorMemoryItem } from '@/types'

interface CreatorLibraryProps { items: CreatorMemoryItem[] }

function stateLabel(state: CreatorMemoryItem['state']): string {
  const labels: Record<string, string> = {
    saved: 'Mentett',
    planned: 'Tervezett',
    in_progress: 'Folyamatban',
    produced: 'Elkészült',
    published: 'Publikált',
    rejected: 'Elvetett',
  }
  return labels[state] || 'Mentett'
}

export default function CreatorLibrary({ items }: CreatorLibraryProps) {
  const visibleItems = items.slice(0, 6)

  return (
    <div className="wv-destination">
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Könyvtár</span><h1>A csatornád alkotói memóriája.</h1></div>
        <Link href="/dashboard/memory" className="wv-secondary-action"><Search aria-hidden="true" />Keresés a teljes memóriában</Link>
      </header>

      {visibleItems.length > 0 ? (
        <section className="wv-library-grid" aria-label="Legutóbbi mentett témák">
          {visibleItems.map((item, index) => (
            <article className="wv-library-item" key={item.id}>
              <div className={`wv-library-visual tone-${(index % 3) + 1}`}><span>{String(index + 1).padStart(2, '0')}</span></div>
              <div className="wv-library-copy"><span className="wv-library-state">{stateLabel(item.state)}</span><h2>{item.topic}</h2><p>{item.opportunity_score !== null ? `Lehetőségpont: ${item.opportunity_score}` : 'Mentett alkotói irány'} · {new Intl.DateTimeFormat('hu-HU').format(new Date(item.updated_at))}</p></div>
            </article>
          ))}
        </section>
      ) : (
        <section className="wv-library-empty">
          <span className="wv-empty-mark"><BookOpen aria-hidden="true" /></span>
          <div><span className="wv-eyebrow">A memória innen épül</span><h2>Még nincs mentett alkotói irány.</h2><p>A Felfedezésből ments el egy lehetőséget, vagy folytasd a szemléltető projektet.</p></div>
          <Link href="/dashboard/discover" className="wv-primary-action">Lehetőség keresése<ArrowUpRight aria-hidden="true" /></Link>
        </section>
      )}

      <section className="wv-tool-rail" aria-label="Könyvtári eszközök">
        <span><FolderOpen aria-hidden="true" /><strong>Kapcsolódó terek</strong></span>
        <Link href="/dashboard/memory"><BookOpen aria-hidden="true" />Teljes tartalommemória</Link>
        <Link href="/dashboard/calendar"><CalendarDays aria-hidden="true" />Alkotói naptár</Link>
      </section>
    </div>
  )
}
