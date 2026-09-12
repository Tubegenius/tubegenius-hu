'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Activity,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Eye,
  FlaskConical,
  ScanLine,
  Stethoscope,
  Target,
  TrendingUp,
} from 'lucide-react'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import {
  CREATOR_GROWTH_PRESENTATION,
  type CreatorGrowthLens,
  type CreatorGrowthSnapshot,
} from '@/lib/creator-growth-presentation'

const LENSES: readonly CreatorGrowthLens[] = ['release', 'pattern']

function RetentionChart({ snapshot }: { snapshot: CreatorGrowthSnapshot }) {
  const width = 680
  const height = 240
  const paddingX = 26
  const top = 24
  const bottom = 36
  const chartHeight = height - top - bottom
  const points = snapshot.chartPoints.map((point, index) => ({
    x: paddingX + (index / (snapshot.chartPoints.length - 1)) * (width - paddingX * 2),
    y: top + ((100 - point) / 100) * chartHeight,
  }))
  const marker = points[Math.min(5, points.length - 1)]
  const polyline = points.map(point => `${point.x},${point.y}`).join(' ')
  const area = `${paddingX},${height - bottom} ${polyline} ${width - paddingX},${height - bottom}`

  return (
    <div className="wv-growth-chart" role="img" aria-label={snapshot.chartLabel}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="wv-growth-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--growth-accent)" stopOpacity="0.24" />
            <stop offset="1" stopColor="var(--growth-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map(line => <line x1={paddingX} x2={width - paddingX} y1={top + line * 48} y2={top + line * 48} key={line} />)}
        <polygon points={area} fill="url(#wv-growth-area)" />
        <polyline points={polyline} className="wv-growth-chart-line" />
        <line x1={marker.x} x2={marker.x} y1={top} y2={height - bottom} className="wv-growth-chart-marker" />
        <circle cx={marker.x} cy={marker.y} r="6" className="wv-growth-chart-dot" />
      </svg>
      <span className="wv-growth-axis is-start">0:00</span>
      <span className="wv-growth-axis is-middle">0:30</span>
      <span className="wv-growth-axis is-end">Vége</span>
      <span className="wv-growth-moment" style={{ left: `${(marker.x / width) * 100}%`, top: `${(marker.y / height) * 100}%` }}>Erős pillanat</span>
    </div>
  )
}

export default function CreatorGrowth() {
  const { creatorLane } = useCreatorOS()
  const [lens, setLens] = useState<CreatorGrowthLens>('release')
  const snapshot = CREATOR_GROWTH_PRESENTATION[creatorLane][lens]

  return (
    <div className="wv-destination" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Növekedés</span><h1>Ne csak a számot lásd. Értsd, mitől mozdult.</h1></div>
        <span className="wv-heading-meta">Szemléltető teljesítményadatok<br />nem élő csatornaállítások</span>
      </header>

      <section className="wv-growth-console" aria-labelledby="wv-growth-console-title">
        <header className="wv-growth-console-head">
          <div>
            <span className="wv-eyebrow">Teljesítménylabor · mintaadat</span>
            <h2 id="wv-growth-console-title">A visszajelzésből legyen következő alkotói döntés.</h2>
          </div>
          <div className="wv-growth-lenses" aria-label="Növekedési nézet választása">
            {LENSES.map(item => (
              <button type="button" aria-pressed={lens === item} onClick={() => setLens(item)} key={item}>
                {CREATOR_GROWTH_PRESENTATION[creatorLane][item].lensLabel}
              </button>
            ))}
          </div>
        </header>

        <div className="wv-growth-main-grid" aria-live="polite">
          <article className="wv-growth-performance">
            <div className="wv-growth-performance-head">
              <div><span>{snapshot.lensLabel}</span><h3>{snapshot.title}</h3></div>
              <div className="wv-growth-primary-metric"><strong>{snapshot.metricValue}</strong><span>{snapshot.metricLabel}</span></div>
            </div>
            <p className="wv-growth-comparison"><TrendingUp aria-hidden="true" />{snapshot.comparison}</p>
            <RetentionChart snapshot={snapshot} />
            <div className="wv-growth-signals">
              {snapshot.signals.map(signal => (
                <div key={signal.label}><span>{signal.label}</span><strong>{signal.value}</strong><small>{signal.context}</small></div>
              ))}
            </div>
          </article>

          <aside className="wv-growth-decision">
            <span className="wv-growth-decision-index">01</span>
            <div><span className="wv-eyebrow">Következő kontrollált teszt</span><h2>{snapshot.nextTest}</h2><p>{snapshot.nextTestDetail}</p></div>
            <div className="wv-growth-test-rule"><FlaskConical aria-hidden="true" /><span>Egy változó módosuljon, hogy az eredmény értelmezhető maradjon.</span></div>
            <Link href="/dashboard/create" className="wv-primary-action">Tesztprojekt megnyitása<ArrowRight aria-hidden="true" /></Link>
          </aside>
        </div>
      </section>

      <section className="wv-feedback-chain" aria-labelledby="wv-feedback-chain-title">
        <header><span className="wv-eyebrow">Visszacsatolási lánc</span><h2 id="wv-feedback-chain-title">Ne álljon meg az analitikánál.</h2></header>
        <div>
          <article><span>01</span><Eye aria-hidden="true" /><strong>Publikált eredmény</strong><p>A videó összehasonlítható jeleket hagy maga után.</p></article>
          <article><span>02</span><ScanLine aria-hidden="true" /><strong>{snapshot.keyMoment}</strong><p>{snapshot.keyMomentDetail}</p></article>
          <article><span>03</span><CheckCircle2 aria-hidden="true" /><strong>{snapshot.audienceMemory}</strong><p>{snapshot.audienceMemoryDetail}</p></article>
          <article className="is-next"><span>04</span><FlaskConical aria-hidden="true" /><strong>{snapshot.nextTest}</strong><p>Egyetlen következő kísérletként kerül vissza az alkotói munkafolyamatba.</p></article>
        </div>
      </section>

      <section className="wv-growth-disclaimer">
        <Activity aria-hidden="true" />
        <p><strong>Mit jelent ez most?</strong> A képernyő a döntési logikát szemlélteti. Valós teljesítményállítás csak a meglévő analitikai és auditadatok bekötése után jelenhet meg.</p>
      </section>

      <section className="wv-tool-rail" aria-label="Növekedési eszközök">
        <span><BarChart3 aria-hidden="true" /><strong>Mélyebb elemzés</strong></span>
        <Link href="/dashboard/overview"><Activity aria-hidden="true" />Aktivitási áttekintés</Link>
        <Link href="/dashboard/channel-audit"><Target aria-hidden="true" />Csatornaaudit</Link>
        <Link href="/dashboard/video-audit"><Stethoscope aria-hidden="true" />Videódiagnózis</Link>
      </section>
    </div>
  )
}
