'use client'

import Link from 'next/link'
import { Activity, ArrowRight, BarChart3, Stethoscope, Target } from 'lucide-react'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

export default function CreatorGrowth() {
  const { creatorLane } = useCreatorOS()

  return (
    <div className="wv-destination" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">Növekedés</span>
          <h1>Csak mért eredményből vonunk le alkotói következtetést.</h1>
        </div>
        <span className="wv-heading-meta">Performance workspace<br />valós csatornaadatokra vár</span>
      </header>

      <section className="wv-truth-hero" aria-labelledby="wv-growth-empty-title">
        <div className="wv-truth-hero-copy">
          <span className="wv-empty-mark"><BarChart3 aria-hidden="true" /></span>
          <div>
            <span className="wv-eyebrow">Teljesítmény-visszacsatolás</span>
            <h2 id="wv-growth-empty-title">Még nincs ezen a felületen összevethető publikációs adatsor.</h2>
            <p>Nem rajzolunk kitalált retention görbét, százalékot vagy csatornaátlagot. A növekedési nézet akkor ad tanácsot, amikor a meglévő audit- és analitikai adatok biztonságosan összekapcsolhatók.</p>
          </div>
        </div>

        <div className="wv-truth-explainer">
          <article>
            <Activity aria-hidden="true" />
            <div><strong>Mi működik?</strong><p>Valós publikációs eredményekből és egységes mérési ablakból lesz megállapítható.</p></div>
          </article>
          <article>
            <Target aria-hidden="true" />
            <div><strong>Mi legyen a következő teszt?</strong><p>Csak mérhető előzmény után jelenik meg; most nem teszünk személyes teljesítményállítást.</p></div>
          </article>
        </div>

        <div className="wv-truth-actions">
          <Link href="/dashboard/channel-audit" className="wv-primary-action">Csatornaaudit megnyitása<ArrowRight aria-hidden="true" /></Link>
          <Link href="/dashboard/video-audit" className="wv-secondary-action"><Stethoscope aria-hidden="true" />Videódiagnózis</Link>
        </div>
      </section>
    </div>
  )
}
