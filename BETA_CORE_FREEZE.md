# WillViral Beta Core Freeze

Ez a dokumentum a WillViral stabil beta core baseline-ját rögzíti. A freeze célja, hogy a bizonyítottan működő core folyamatok változatlan referenciapontot képezzenek a következő fejlesztési fázisokhoz.

## 1. Freeze dátuma és commitja

- Freeze dátuma: **2026. július 18.**
- Branch: `main`
- Baseline commit: `fe50ef1`
- Commit üzenete: `fix: resolve dashboard hydration mismatch`
- A freeze ellenőrzésekor a `main` és az `origin/main` szinkronban volt.
- A munkakönyvtár tiszta volt.

## 2. Production deploy státusz

- Környezet: **Production**
- Vercel státusz: **Ready**
- Deployolt commit: `fe50ef1`
- Production URL: `https://tubegenius-hu.vercel.app`
- A production alkalmazás bejelentkezett munkamenetben elérhető és használható volt.
- A dashboard hydration javítása után konzolhiba nem jelentkezett az ellenőrzött oldalakon.

## 3. Lefuttatott tesztek és ellenőrzések

- Teljes automatizált regressziós tesztcsomag: **116/116 sikeres** (`25/25` tesztfájl).
- Pénzügyi bucket regresszió: **28/28 sikeres**.
- TypeScript-ellenőrzés és lint: **sikeres**.
- Next.js production build: **sikeres**.
- Statikus oldalgenerálás: **78/78 sikeres**.
- Production smoke test: **sikeres**, az alább dokumentált korlátozásokkal.
- Vercel production deploy ellenőrzése: **Ready**.

## 4. Stabilnak minősített core flow-k

### Login / auth

- A production dashboard aktív munkamenetben, login oldalra történő visszairányítás nélkül betöltött.

### YouTube OAuth

- A YouTube-fiók összekapcsolt állapota megjelent.
- A Channel Audit valós YouTube analytics adatokat töltött be.
- Az OAuth újracsatlakoztatási folyamatot a smoke test nem indította újra, mert az módosította volna a stabil production kapcsolatot.

### Channel Audit

- A csatornaadatok, valós analytics, auditátlagok és mentett AI-javaslatok betöltődtek.
- A mentett Channel Audit eredmény kreditmentesen újranyílt.
- A mentett eredmény pontosan 10 következő videótémát tartalmazott.

### Niche felismerés

- A csatorna alapján súlyozott tartalomirányok és indoklások megjelentek.
- A kiválasztott niche a további folyamatokban elérhető volt.

### Topic generation

- A Channel Audit a csatorna mintázataiból konkrét, gyártható topic-javaslatokat adott.
- A content pillar / niche kontextus és a konkrét topicok közötti kapcsolat működött.

### Similar Videos

- A route és a felület működött.
- A mentett eredmény újranyitható volt.
- A relevanciaszűrés szabályosan adhat üres eredményt, ha nincs elég megfelelő videó.

### Viral Score route/UI

- A route és a felület hibamentesen betöltött.
- A meglévő regressziós tesztek sikeresek.
- A freeze smoke test nem indított új, kreditfogyasztó Viral Score-generálást.

### Video Package

- A mentett teljes gyártási csomag újranyílt.
- A mentett opportunity/source context megjelent.
- A bizonyítékvideó-snapshot megjelent; az ellenőrzött csomag 2 bizonyítékvideót és 1 webes forrást tartalmazott.
- Az újranyitás nem függött session contexttől.

### Paid Results

- A dashboardon és a Tartalommemóriában mentett eredmények jelentek meg.
- A paid-result mentési és input-hash logika regressziós tesztekkel védett.

### Credit balance

- A production felületen ellenőrzött teljes egyenleg: **194 kredit**.
- A mentett eredmények újranyitása előtt és után az egyenleg változatlan maradt.

### Paid-result reopen

- Channel Audit és Video Package mentett eredmény kreditmentesen újranyílt.
- A felület egyértelműen jelezte, hogy az újranyitás nem vont le új kreditet.
- A paid-result reopen nem hívja meg a `spend_credits` RPC-t.

## 5. Pénzügyi core státusz

A pénzügyi core a freeze időpontjában **stabil beta** státuszú.

### Kredit bucketek

- `subscription_credit_balance`: előfizetésből származó kreditek.
- `purchased_credit_balance`: külön megvásárolt top-up kreditek.
- Production baseline a freeze idején:
  - `subscription_credit_balance = 0`
  - `purchased_credit_balance = 194`
  - `balance = 194`

### Balance kompatibilitás

- A kompatibilitási mező megmaradt.
- Kötelező invariáns:

```text
balance = subscription_credit_balance + purchased_credit_balance
```

- A teljes elérhető egyenleg ugyanezen két bucket összege.
- Negatív bucket- és teljes egyenleg ellen adatbázis-constraint véd.

### Top-up / renewal / cap szabály

- A top-up kizárólag a `purchased_credit_balance` bucketet növeli.
- Az előfizetés indulása és havi renewalja kizárólag a `subscription_credit_balance` bucketet érinti.
- A rollover cap kizárólag az előfizetéses bucketre alkalmazható.
- A megvásárolt kredit renewal vagy rollover cap miatt nem csökkenhet és nem veszhet el.
- A Stripe webhookok idempotensek; duplikált esemény nem írhat jóvá kétszer.

### Felhasználás és refund

- A kreditfelhasználás először az előfizetéses bucketből, majd szükség esetén a vásárolt bucketből von.
- A ledger rögzíti a bucket szerinti felosztást.
- A refund az eredeti `credit_transaction_id` alapján, pontosan az eredeti bucket-felosztás szerint írja vissza a kreditet.
- A duplikált refund idempotens.

## 6. Ismert non-blocker korlátozások

- A Similar Videos egy adott querynél szabályosan adhat üres eredményt, ha nincs elég releváns, friss és megfelelő potenciálú videó.
- Az 1/3 releváns auditot tartalmazó Channel Audit preflight production fiókon nem lett újrajátszva, mert az ellenőrzött fiók már 4 audittal rendelkezett. A szabály automatizált regresszióval védett.
- Szándékos production AI/API hibát nem váltottunk ki, ezért a refund production smoke testben nem aktiválódott. A refund működését regressziós és pénzügyi tesztek igazolják.
- A freeze smoke testben nem indult új Viral Score-generálás, így ehhez nem történt új kreditfogyasztás.
- A nyers `/api/credits` JSON-válasz közvetlen böngészős megnyitását a kliensoldali védelem blokkolta; a response contractot, bucket-invariánst és kompatibilitást regressziós tesztek, valamint a production egyenleg igazolta.

Ezek egyike sem minősül Beta Core Freeze blockernek.

## 7. Freeze után tiltott módosítások külön jóváhagyás nélkül

Az alábbi területek a stabil core részét képezik. Módosításukhoz külön, kifejezett jóváhagyás, célzott terv és regressziós ellenőrzés szükséges:

- Stripe-integráció és webhookok;
- billing és előfizetés-kezelés;
- credit bucketek, kreditfelhasználás és refund;
- `paid_results` mentési, hash- és újranyitási logika;
- adatbázis-migrációk;
- OAuth core és YouTube tokenkezelés;
- Channel Audit core és generálási logika;
- Video Package core és generálási logika.

Freeze után ezeken a területeken nem megengedett előzetes jóváhagyás nélküli refaktor, response/request contract változtatás, migráció vagy üzleti szabálymódosítás.

## 8. Következő ajánlott fázis

A következő fejlesztési fázis a stabil core módosítása helyett a termékélmény és a piacra lépés előkészítésére koncentráljon:

1. lokális UX-finomítás és célzott frontend QA;
2. beta user onboarding és első sikerélmény optimalizálása;
3. pricing- és kreditkommunikáció egyértelműsítése;
4. strukturált feedback rendszer kialakítása;
5. dashboard vizuális és információs prémiumosítása.

Minden következő fázisban a `fe50ef1` commit és ez a dokumentum jelenti a stabil beta core összehasonlítási alapját.
