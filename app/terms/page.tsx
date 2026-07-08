import Link from 'next/link'

export const metadata = {
  title: 'Általános Szerződési Feltételek — WillViral',
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <Link href="/" className="text-sm text-violet hover:underline">← Vissza</Link>

        <h1 className="text-3xl font-bold text-text-primary mt-4 mb-2">Általános Szerződési Feltételek</h1>
        <p className="text-text-muted text-sm mb-10">Hatályos: 2026. július 7-től</p>

        <div className="space-y-8 text-text-secondary text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">1. A Szolgáltatás</h2>
            <p>
              A WillViral (willviral.com, „Szolgáltatás") egy YouTube- és rövid videós tartalomkészítőknek szóló
              platform, amely nyilvánosan elérhető adatok (YouTube-videók, hírek) alapján segít témát validálni,
              majd videócsomagot (cím, hook, script, hashtagek, feltöltési javaslatok) generálni. A jelen
              dokumentum a Szolgáltatás használatának feltételeit rögzíti a Felhasználó és az Üzemeltető között.
            </p>
            <p className="mt-2">
              Üzemeltető: <strong className="text-text-primary">[CÉGNÉV / EGYÉNI VÁLLALKOZÓ NEVE — kérlek töltsd ki]</strong>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">2. Regisztráció és fiók</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>A Szolgáltatás használatához regisztráció szükséges, valós email cím megadásával.</li>
              <li>A fiókodhoz tartozó bejelentkezési adatokat bizalmasan kell kezelned; a fiókod alatt történt
                tevékenységért felelősséggel tartozol.</li>
              <li>A Szolgáltatás jelenleg béta állapotban van — ez azt jelenti, hogy egyes funkciók vagy díjcsomagok
                előzetes értesítés nélkül is változhatnak a béta időszak alatt.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">3. Kreditek, előfizetés és fizetés</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Egyes funkciók („kredites funkciók") a fiókodhoz tartozó kredit-egyenleg terhére vehetők igénybe.</li>
              <li>Az előfizetési csomagok havonta megújuló kreditkeretet biztosítanak; a fel nem használt kredit
                a mindenkori csomagfeltételek szerint görgethető át (rollover-korlátig).</li>
              <li>A fizetést a Stripe dolgozza fel. Bankkártya-adatot mi nem tárolunk.</li>
              <li>A már felhasznált kreditért járó díj nem visszatéríthető. Az előfizetés bármikor lemondható a
                Kreditek oldalon, a lemondás a következő számlázási ciklustól lép életbe.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">4. Az AI-generált tartalom természete — fontos korlátozás</h2>
            <p className="mb-2">
              A Szolgáltatás célja, hogy <strong className="text-text-primary">valós, nyilvános adatok alapján
              segítsen felmérni egy téma piaci relevanciáját</strong>, és ez alapján gyártásra kész tartalmi
              csomagot (cím, hook, script, hashtagek stb.) generáljon.
            </p>
            <p className="mb-2">
              <strong className="text-text-primary">A Szolgáltatás nem garantálja</strong>, hogy egy adott,
              validált téma alapján készült videó konkrét nézettséget, elérést vagy bevételt fog elérni. A
              végeredmény számos, a Szolgáltatáson kívül eső tényezőtől függ (pl. kivitelezés, vágás,
              csatornaméret, publikálási időzítés, platform algoritmusa). A Szolgáltatás egy döntéstámogató
              eszköz, nem eredménygarancia.
            </p>
            <p>
              A generált szöveges tartalom (script, leírás, cím) mesterséges intelligencia által készül. A
              Felhasználó felelőssége, hogy a végleges tartalmat közzététel előtt ellenőrizze, és azt saját
              megítélése szerint módosítsa.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">5. Tiltott felhasználás</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Tilos a Szolgáltatást automatizált módon, a rendes felhasználói interakciót meghaladó mértékben
                lekérdezni (pl. scraping, tömeges automatizált lekérdezés).</li>
              <li>Tilos a Szolgáltatáson keresztül elért, harmadik féltől (pl. YouTube, Google) származó adatokat
                a forrás saját feltételeit megsértve továbbadni vagy újra kereskedelmi forgalomba hozni.</li>
              <li>Tilos jogellenes, megtévesztő vagy mások jogait sértő tartalom létrehozására használni a
                Szolgáltatást.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">6. Szellemi tulajdon</h2>
            <p>
              A Szolgáltatás szoftvere és megjelenése az Üzemeltető szellemi tulajdona. A Felhasználó a
              Szolgáltatással generált saját tartalmat (script, cím, leírás) szabadon felhasználhatja saját
              videóihoz.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">7. Felelősség korlátozása</h2>
            <p>
              A Szolgáltatást „ahogy van" alapon nyújtjuk. Az Üzemeltető a jogszabályok által megengedett
              legteljesebb mértékben kizárja a felelősségét a Szolgáltatás használatából eredő közvetett
              károkért, elmaradt haszonért vagy nézettség-elmaradásért.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">8. Fiók felfüggesztése, megszüntetése</h2>
            <p>
              Az Üzemeltető jogosult felfüggeszteni vagy megszüntetni a fiókodat, ha megsérted a jelen
              feltételeket, különösen a tiltott felhasználásra vonatkozó pontot.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">9. Alkalmazandó jog</h2>
            <p>
              A jelen feltételekre a magyar jog irányadó. Az adatkezelésről bővebben az{' '}
              <Link href="/privacy" className="text-violet hover:underline">Adatvédelmi Szabályzatban</Link> olvashatsz.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">10. Kapcsolat</h2>
            <p>Kérdés esetén írj: <strong className="text-text-primary">support@willviral.com</strong></p>
          </section>
        </div>
      </div>
    </div>
  )
}
