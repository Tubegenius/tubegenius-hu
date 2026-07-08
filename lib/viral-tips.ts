export type ViralTip = {
  id: string
  category: "hook" | "retention" | "story" | "trend" | "packaging" | "cta" | "editing" | "strategy"
  title: string
  body: string
  action: string
  appliesTo: Array<"tiktok" | "shorts" | "reels" | "youtube">
  level: "beginner" | "intermediate" | "advanced"
}

export const viralTips: ViralTip[] = [
  { id: "hook_001", category: "hook", title: "Az első 3 másodperc nem bevezető.", body: "Ne magyarázattal kezdj. Kezdj következménnyel, furcsa ténnyel vagy kérdéssel. A nézőnek azonnal tudnia kell, miért maradjon.", action: "Írd át a mai hook első mondatát úgy, hogy rögtön legyen benne tét.", appliesTo: ["tiktok", "shorts", "reels"], level: "beginner" },
  { id: "hook_002", category: "hook", title: "Ne témát mondj. Feszültséget mutass.", body: "A \"Budapest változik\" gyenge. A \"Budapesten most olyan változás indul, amit sokan csak későn vesznek észre\" már feszültséget ad.", action: "A mai témához írj 3 olyan hookot, amiben van változás vagy konfliktus.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "hook_003", category: "hook", title: "A jó hook kérdést nyit, nem választ ad.", body: "Ha az első mondat mindent elárul, nincs ok továbbnézni. Nyiss egy kérdést, amit a videó végére válaszolsz meg.", action: "Tedd fel a kérdést: \"Mi az, amit a néző még nem tud, de tudni akar majd?\"", appliesTo: ["tiktok", "shorts", "reels"], level: "beginner" },
  { id: "hook_004", category: "hook", title: "A \"miért most?\" erősebb, mint a \"miről szól?\".", body: "A nézőt nem csak a téma érdekli, hanem az aktualitás. Mondd meg, miért pont most fontos ez.", action: "A hookba építsd bele: \"miért most történik ez?\"", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "hook_005", category: "hook", title: "Kerüld a túl általános kezdést.", body: "Az olyan kezdések, mint \"Sokan nem tudják\" vagy \"Érdekes dolog történt\" túl gyengék. Legyen konkrétabb és erősebb.", action: "Cseréld le az általános kezdést egy konkrét következményre.", appliesTo: ["tiktok", "shorts", "reels"], level: "beginner" },
  { id: "retention_001", category: "retention", title: "Egy videó = egy ígéret.", body: "Ha egy rövid videó túl sok dolgot akar elmondani, leesik a megtartás. Egy kérdés, egy konfliktus, egy felismerés.", action: "Vágj ki minden mellékszálat, ami nem viszi előre az első ígéretet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "retention_002", category: "retention", title: "Minden 5 másodpercben történjen valami.", body: "Nem kell nagy vágás, de kell új információ, új kép, új fordulat vagy új kérdés. A néző figyelme gyorsan esik.", action: "Nézd át a scriptedet, és jelöld be, hol van 5 másodpercnél hosszabb üres rész.", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "retention_003", category: "retention", title: "A videó közepe ne legyen magyarázati mocsár.", body: "Sok videó nem a hooknál bukik el, hanem középen. A középső részben is kell feszültség, nem csak háttérmagyarázat.", action: "A középső részbe tegyél egy fordulatot vagy új kérdést.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "retention_004", category: "retention", title: "A néző mindig tudja, mire vár.", body: "Ha nem világos, hova tart a videó, a néző kilép. Adj neki egy nyitott ígéretet, amit végig követhet.", action: "A hook után mondd ki vagy sugalljad: \"a végére kiderül, miért fontos\".", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "retention_005", category: "retention", title: "Ne zárd le túl korán a kíváncsiságot.", body: "Ha az első 10 másodpercben megadod a teljes választ, a nézőnek nincs oka maradni. Adagold az információt.", action: "A legfontosabb választ ne az elejére, hanem a videó utolsó harmadába tedd.", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "story_001", category: "story", title: "Ha nincs ellentét, nincs sztori.", body: "A legtöbb erős videó mögött ellentét van: régi vs új, hittük vs kiderült, veszély vs megoldás, kis jel vs nagy következmény.", action: "A mai témához keress egy fő ellentétet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "story_002", category: "story", title: "A jó sztori változással indul.", body: "A nézőt az érdekli, hogy valami megváltozott. Egy új szabály, új felfedezés, új szereplő vagy váratlan fordulat erősebbé teszi a témát.", action: "Írd le egy mondatban: mi változott a témában?", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "story_003", category: "story", title: "A konkrét szereplő erősebb, mint az általános téma.", body: "A \"sportban változás van\" gyenge. Egy konkrét csapat, ember, város vagy esemény sokkal könnyebben megfogható.", action: "A témádból válassz ki egy konkrét szereplőt vagy helyszínt.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "story_004", category: "story", title: "A néző nem adatot akar, hanem következményt.", body: "Az adat csak akkor érdekes, ha megmutatod, miért számít. Mit változtat meg? Kit érint? Mi lehet belőle?", action: "Minden fontos adat után írd oda: \"ez azért számít, mert...\"", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "story_005", category: "story", title: "A végén legyen felismerés.", body: "A jó videó nem csak informál, hanem átfordítja a néző gondolkodását. A végén legyen egy mondat, amit megjegyez.", action: "Írj egy zárómondatot, ami összefoglalja a felismerést.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "trend_001", category: "trend", title: "Nem minden friss téma jó videótéma.", body: "A frissesség önmagában kevés. Akkor erős, ha van benne konfliktus, következmény vagy vizuálisan elmesélhető fordulat.", action: "A mai témánál ellenőrizd: van benne tét, változás vagy meglepetés?", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "trend_002", category: "trend", title: "A korai lehetőség nem gyenge lehetőség.", body: "Ha webes források már írnak róla, de kevés videó készült, az tartalmi rés lehet. Ilyenkor óvatos, gyors tesztvideóval érdemes indulni.", action: "Korai témánál készíts rövid, óvatos tesztvideót, ne végleges nagy állítást.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "trend_003", category: "trend", title: "A túl tág niche gyenge ajánlást ad.", body: "A \"Budapest\" túl széles. A \"budapesti sportesemények\", \"városi szabályváltozások\" vagy \"rejtélyes budapesti helyek\" pontosabb irány.", action: "Pontosítsd a niche-edet legalább egy alkategóriával.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "trend_004", category: "trend", title: "A content gap lehetőség.", body: "Ha egy témáról van friss webes jel, de kevés videós feldolgozás, az nem feltétlenül baj. Lehet, hogy még előtted van a piac.", action: "Nézd meg: a témáról van-e webes aktualitás, de kevés videó?", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "trend_005", category: "trend", title: "A trendet ne másold, fordítsd át.", body: "Nem az a cél, hogy ugyanazt csináld, mint más. A cél, hogy megtaláld a működő szöget, majd a saját közönségedre alakítsd.", action: "Egy sikeres videóból ne a témát másold, hanem a szerkezetet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "packaging_001", category: "packaging", title: "A cím ígéret, nem leírás.", body: "A \"Budapesti események\" leírás. A \"Budapesten most valami megváltozik, amit sokan csak későn vesznek észre\" ígéret.", action: "Írd át a címet úgy, hogy legyen benne kíváncsiság vagy következmény.", appliesTo: ["youtube", "shorts", "tiktok", "reels"], level: "beginner" },
  { id: "packaging_002", category: "packaging", title: "A thumbnail egyetlen gondolatot adjon el.", body: "Ha túl sok szöveg, arc, nyíl és ikon van rajta, gyengül. Egy fő vizuális állítás legyen.", action: "A thumbnailből törölj minden elemet, ami nem az első kíváncsiságot erősíti.", appliesTo: ["youtube", "shorts"], level: "intermediate" },
  { id: "packaging_003", category: "packaging", title: "A jó overlay nem megismétli a címet.", body: "A képernyőszöveg akkor erős, ha új feszültséget ad. Ne ugyanaz legyen, mint a narráció első mondata.", action: "Írj egy overlay sort, ami más szögből erősíti a hookot.", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "packaging_004", category: "packaging", title: "A rövid cím jobb, mint az okos cím.", body: "A néző nem akar megfejteni egy címet. Gyorsan érthető, erős, konkrét ígéret kell.", action: "A címet vágd vissza 6–9 szóra.", appliesTo: ["youtube", "shorts", "tiktok", "reels"], level: "beginner" },
  { id: "packaging_005", category: "packaging", title: "A curiosity gap legyen tiszta, ne ködös.", body: "A \"senki nem tudja, mi történik\" túl homályos. Jobb: \"egy döntés megváltoztathatja, mi történik ezután\".", action: "Cseréld le a ködös kíváncsiságot konkrét kérdésre.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "editing_001", category: "editing", title: "A vágás ne csak gyors legyen, hanem értelmes.", body: "A gyors vágás önmagában nem tartja meg a nézőt. Minden vágás új információt vagy új vizuális fókuszt adjon.", action: "Nézd át: minden vágás hozzáad valamit, vagy csak mozgatja a képet?", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "editing_002", category: "editing", title: "A B-roll ne dísz legyen.", body: "A jó B-roll segít megérteni a sztorit. Ha csak szép, de nem segít, gyengítheti a figyelmet.", action: "Minden B-roll mellé írd oda: mit magyaráz vagy erősít?", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "editing_003", category: "editing", title: "A képernyőszöveg ritmust ad.", body: "Nem kell mindent kiírni. Csak a kulcsszavakat, fordulatokat és számokat. Így a néző könnyebben követi.", action: "A scriptből válassz ki 3–5 szót, amit biztosan kiírnál overlayként.", appliesTo: ["tiktok", "shorts", "reels"], level: "beginner" },
  { id: "editing_004", category: "editing", title: "A csend is eszköz, de ritkán.", body: "Egy rövid szünet erősíthet egy fordulatot, de túl sok csend megtöri a lendületet.", action: "Csak ott hagyj szünetet, ahol tényleg fordulat vagy felismerés jön.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "editing_005", category: "editing", title: "A vizuál kövesse a mondat súlyát.", body: "A legerősebb mondathoz ne gyenge kép társuljon. A csúcspontnál legyen a legerősebb vizuális elem.", action: "Jelöld ki a scripted legerősebb mondatát, és adj hozzá külön vizuális ötletet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "cta_001", category: "cta", title: "A CTA ne könyörgés legyen.", body: "A \"kövess be\" gyenge, ha nincs oka. Adj okot: mit kap a néző, ha marad?", action: "A CTA-t írd át értékígéretre: \"kövess, ha ilyen témákat akarsz látni\".", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "cta_002", category: "cta", title: "A mentés erősebb lehet, mint a like.", body: "Oktató, lista, tipp vagy magyarázó videónál a mentés gyakran jobb cél, mint a like.", action: "Ha hasznos videót készítesz, a végén kérj mentést, ne csak like-ot.", appliesTo: ["tiktok", "shorts", "reels"], level: "intermediate" },
  { id: "cta_003", category: "cta", title: "A kommentkérdés legyen könnyű.", body: "Ne kérj hosszú választ. A jó kommentkérdésre gyorsan lehet reagálni: igen/nem, A/B, melyik, szerinted?", action: "A videó végére írj egy egyszerű A/B kommentkérdést.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "cta_004", category: "cta", title: "A CTA kapcsolódjon a videó ígéretéhez.", body: "Ha a videó rejtélyről szólt, a CTA is kapcsolódjon ehhez: \"kövess a következő részért\" vagy \"írjam meg a folytatást?\"", action: "A CTA-t igazítsd a videó fő feszültségéhez.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "cta_005", category: "cta", title: "Ne legyen három CTA egyszerre.", body: "Ha egyszerre kéred a like-ot, kommentet, követést és megosztást, egyik sem lesz elég erős.", action: "Válassz egyetlen fő CTA-t a videó célja alapján.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
  { id: "strategy_001", category: "strategy", title: "A gyenge videót ne mindig dobd ki.", body: "Lehet, hogy nem a téma volt rossz, csak a hook, cím vagy vizuális csomagolás. Előbb diagnosztizáld.", action: "Egy gyenge videónál külön nézd meg: hook, megtartás, cím, vizuál, téma.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "strategy_002", category: "strategy", title: "A jó creator nem csak gyárt, hanem tanul a jelekből.", body: "A nézettség, mentés, komment és átkattintás mind visszajelzés. Ne érzelmi alapon dönts, hanem mintázatok alapján.", action: "A következő videó előtt nézd meg, melyik korábbi témád kapott több mentést vagy kommentet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "strategy_003", category: "strategy", title: "A sorozatformátum visszahozza a nézőt.", body: "Egyetlen videó helyett gondolkodj sorozatban. Ha a téma működik, készíts belőle 3 eltérő szögű részt.", action: "A mai témához írj 3 folytatásötletet.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "intermediate" },
  { id: "strategy_004", category: "strategy", title: "A saját verzió fontosabb, mint az inspiráció.", body: "Más videója csak kiindulópont. A te feladatod: más célközönség, más hook, más példa, más történeti szög.", action: "Egy inspirációs videóból írd ki: mit tartasz meg, mit változtatsz meg.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "advanced" },
  { id: "strategy_005", category: "strategy", title: "Ne akkor keress témát, amikor már posztolni kell.", body: "A jó videók előbb téma- és hookdöntésből születnek. Ha kapkodva választasz témát, a gyártás is gyengébb lesz.", action: "Ments el legalább 5 témát a Tartalommemóriába, mielőtt gyártani kezdesz.", appliesTo: ["tiktok", "shorts", "reels", "youtube"], level: "beginner" },
]

export function getDailyTip(platform?: string): ViralTip {
  const now = new Date()
  const start = new Date(now.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86400000)

  let pool = viralTips
  if (platform) {
    const platformMap: Record<string, string> = {
      youtube_shorts: 'shorts', tiktok: 'tiktok', instagram_reels: 'reels',
      youtube_long: 'youtube', youtube: 'youtube', facebook_reels: 'reels',
    }
    const mapped = platformMap[platform] || platform
    const filtered = viralTips.filter(t => t.appliesTo.includes(mapped as never))
    if (filtered.length > 0) pool = filtered
  }

  return pool[dayOfYear % pool.length]
}

const categoryIcons: Record<string, string> = {
  hook: 'ti-bolt', retention: 'ti-clock', story: 'ti-book',
  trend: 'ti-trending-up', packaging: 'ti-package', cta: 'ti-hand-click',
  editing: 'ti-cut', strategy: 'ti-chess',
}

const categoryColors: Record<string, string> = {
  hook: '#3B82F6', retention: '#8B5CF6', story: '#F59E0B',
  trend: '#22C55E', packaging: '#EC4899', cta: '#F97316',
  editing: '#06B6D4', strategy: '#14B8A6',
}

export function getCategoryIcon(category: string): string {
  return categoryIcons[category] || 'ti-bulb'
}

export function getCategoryColor(category: string): string {
  return categoryColors[category] || '#3B82F6'
}
