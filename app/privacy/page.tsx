import Link from 'next/link'

export const metadata = {
  title: 'Adatvédelmi Szabályzat — WillViral',
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <Link href="/" className="text-sm text-violet hover:underline">← Vissza</Link>

        <h1 className="text-3xl font-bold text-text-primary mt-4 mb-2">Adatvédelmi Szabályzat</h1>
        <p className="text-text-muted text-sm mb-10">Hatályos: 2026. július 7-től</p>

        <div className="space-y-8 text-text-secondary text-sm leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">1. Adatkezelő</h2>
            <p>
              A WillViral (willviral.com, „Szolgáltatás", „mi") a jelen szabályzatban leírtak szerint kezeli
              a felhasználók („te", „Felhasználó") személyes adatait.
            </p>
            <p className="mt-2">
              Adatkezelő: <strong className="text-text-primary">[CÉGNÉV / EGYÉNI VÁLLALKOZÓ NEVE — kérlek töltsd ki]</strong><br />
              Székhely: <strong className="text-text-primary">[SZÉKHELY CÍME — kérlek töltsd ki]</strong><br />
              Kapcsolat: <strong className="text-text-primary">privacy@willviral.com</strong>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">2. Milyen adatokat kezelünk</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong className="text-text-primary">Regisztrációs adatok:</strong> email cím, jelszó (titkosítva, a Supabase Auth kezeli).</li>
              <li><strong className="text-text-primary">Profiladatok:</strong> csatornanév, niche/szakterület, nyelvi és stílus-beállítások, amiket a Creator Profilban megadsz.</li>
              <li><strong className="text-text-primary">Használati adatok:</strong> a megadott témák, keresések, generált tartalmak (videócsomagok, script-ek, elemzések), kredit-felhasználási előzmények.</li>
              <li><strong className="text-text-primary">Feltöltött fájlok:</strong> az Auto Transcript funkcióhoz feltöltött hang-/videófájlok, kizárólag a leirat elkészítéséhez.</li>
              <li><strong className="text-text-primary">Fizetési adatok:</strong> a bankkártya-adatokat mi nem tároljuk — ezeket a Stripe kezeli az ő saját adatvédelmi szabályzata szerint. Mi csak az előfizetés státuszát és a tranzakció azonosítóját tároljuk.</li>
              <li><strong className="text-text-primary">Technikai adatok:</strong> munkamenet-azonosító (bejelentkezés fenntartásához), alapvető szerverlogok (hibakereséshez).</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">3. Miért kezeljük az adataidat (jogalap)</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>A szolgáltatás nyújtásához szükséges — <strong className="text-text-primary">szerződés teljesítése</strong> (GDPR 6. cikk (1) b) pont).</li>
              <li>Számlázási és jogi kötelezettségek teljesítése — <strong className="text-text-primary">jogi kötelezettség</strong> (GDPR 6. cikk (1) c) pont).</li>
              <li>A szolgáltatás biztonsága, visszaélések megelőzése, a szolgáltatás fejlesztése — <strong className="text-text-primary">jogos érdek</strong> (GDPR 6. cikk (1) f) pont).</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">4. Kikkel osztjuk meg az adatokat (adatfeldolgozók)</h2>
            <p className="mb-2">
              Az adataidat nem adjuk el, és nem osztjuk meg harmadik féllel marketingcélra. A szolgáltatás
              működtetéséhez az alábbi adatfeldolgozókat vesszük igénybe:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong className="text-text-primary">Supabase</strong> (adatbázis és bejelentkezés-kezelés, EU/Írország szerverrégió) — a fiók- és profiladatokat itt tároljuk.</li>
              <li><strong className="text-text-primary">Stripe</strong> (fizetésfeldolgozás, Egyesült Államok) — az előfizetések és bankkártyás fizetések kezelése.</li>
              <li><strong className="text-text-primary">Anthropic</strong> (Claude AI, Egyesült Államok) — a megadott témák és tartalom-kérések alapján AI-generált szöveges tartalom (script, elemzés) előállítása.</li>
              <li><strong className="text-text-primary">OpenAI</strong> (Egyesült Államok) — kizárólag az Auto Transcript funkció használatakor, a feltöltött hangfájl szöveggé alakításához.</li>
              <li><strong className="text-text-primary">Google / YouTube Data API</strong> — nyilvánosan elérhető videó- és csatornaadatok (megtekintésszám, cím stb.) lekérdezésére, a te keresésed alapján. Ez nem a te saját YouTube-fiókodhoz való hozzáférés, hanem nyilvános adatok lekérdezése.</li>
              <li><strong className="text-text-primary">Serper</strong> (Egyesült Államok) — nyilvános web- és hírkeresési adatok lekérdezése a piaci validációhoz.</li>
            </ul>
            <p className="mt-2">
              Ahol az adatfeldolgozó az Európai Gazdasági Térségen kívül (pl. Egyesült Államok) dolgozza fel az
              adatot, ott a GDPR által megkövetelt megfelelő garanciákat (pl. Standard Szerződési Feltételek —
              Standard Contractual Clauses) alkalmazzuk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">5. Meddig őrizzük az adatokat</h2>
            <p>
              Az adataidat a fiókod aktív fennállása alatt tároljuk. Fiók törlése esetén a személyes adataidat
              legfeljebb 30 napon belül töröljük, kivéve, ha jogszabály (pl. számviteli kötelezettség) hosszabb
              megőrzést ír elő a számlázási adatokra.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">6. A te jogaid</h2>
            <p className="mb-2">A GDPR alapján jogod van:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>hozzáférést kérni a rólad tárolt adatokhoz,</li>
              <li>kérni az adatok helyesbítését, ha pontatlanok,</li>
              <li>kérni az adatok törlését („elfeledtetéshez való jog"),</li>
              <li>kérni az adatkezelés korlátozását,</li>
              <li>adathordozhatóságot kérni (az adataidat géppel olvasható formában megkapni),</li>
              <li>tiltakozni az adatkezelés ellen,</li>
              <li>panaszt tenni a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH, naih.hu).</li>
            </ul>
            <p className="mt-2">
              Ezen jogok gyakorlásához írj a <strong className="text-text-primary">privacy@willviral.com</strong> címre.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">7. Cookie-k</h2>
            <p>
              Kizárólag a bejelentkezés fenntartásához szükséges, alapvető munkamenet-cookie-kat használunk.
              Nem használunk hirdetési vagy analitikai (követő) cookie-kat.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">8. Gyermekek adatai</h2>
            <p>
              A szolgáltatás nem 18 év alatti személyeknek szól, és tudatosan nem gyűjtünk adatot 18 év alatti
              felhasználóktól.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">9. Módosítások</h2>
            <p>
              Ezt a szabályzatot időről időre frissíthetjük. A lényeges változásokról a fiókodhoz tartozó email
              címen értesítünk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-text-primary mb-2">10. Kapcsolat</h2>
            <p>Kérdés esetén írj: <strong className="text-text-primary">privacy@willviral.com</strong></p>
          </section>
        </div>
      </div>
    </div>
  )
}
