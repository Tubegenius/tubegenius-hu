import Link from 'next/link'
import { Activity, ArrowUpRight, BarChart3, Stethoscope, Target } from 'lucide-react'

export default function CreatorGrowth() {
  return (
    <div className="wv-destination">
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Növekedés</span><h1>Ne csak a számot lásd. Értsd, mitől mozdult.</h1></div>
        <span className="wv-heading-meta">Szemléltető teljesítményadatok<br />utolsó 28 nap</span>
      </header>

      <section className="wv-growth-grid" aria-label="Szemléltető növekedési összefüggések">
        <article className="wv-growth-card"><span className="wv-eyebrow">Nézői megtartás</span><strong className="wv-growth-value">+8,4%</strong><p>Az összehasonlító nyitások hosszabban tartják meg a visszatérő nézőket.</p><div className="wv-growth-bars" aria-hidden="true"><i style={{ height: '31%' }} /><i style={{ height: '38%' }} /><i style={{ height: '45%' }} /><i style={{ height: '62%' }} /><i style={{ height: '76%' }} /></div></article>
        <article className="wv-growth-card"><span className="wv-eyebrow">Közönségmemória</span><strong className="wv-growth-value is-copy">„Mutasd meg”</strong><p>A nézőid erősebben reagálnak, amikor az első húsz másodpercben vizuális különbséget látnak.</p></article>
        <article className="wv-growth-card"><span className="wv-eyebrow">Következő teszt</span><strong className="wv-growth-value">2 nyitás</strong><p>Ugyanazt a videóígéretet számmal és személyes következménnyel is próbáld ki.</p><Link href="/dashboard/create" className="wv-primary-action">Teszt megnyitása<ArrowUpRight aria-hidden="true" /></Link></article>
      </section>

      <section className="wv-growth-insight">
        <span className="wv-insight-mark"><Activity aria-hidden="true" /></span>
        <div><span className="wv-eyebrow">Korai visszacsatolás</span><h2>A bizonyítékot mutató jelenetnél csökkent legkevésbé a figyelem.</h2><p>Ez szemléltető összefüggés, nem tényleges csatornaállítás. Valós adat csak a meglévő analitikai szerződésből kerülhet ide.</p></div>
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
