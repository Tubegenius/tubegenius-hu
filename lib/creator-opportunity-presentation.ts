import type { CreatorLane } from '@/lib/creator-lane-presentation'

export type OpportunityAccent = 'cyan' | 'lime' | 'coral'

export interface CreatorOpportunity {
  id: string
  lane: CreatorLane
  index: string
  title: string
  description: string
  tags: readonly string[]
  horizon: string
  momentum: string
  channelFit: string
  whyNow: string
  audiencePromise: string
  nextMove: string
  accent: OpportunityAccent
}

export const CREATOR_OPPORTUNITIES: Record<CreatorLane, readonly CreatorOpportunity[]> = {
  evidence: [
    {
      id: 'night-heat',
      lane: 'evidence',
      index: '01',
      title: 'Miért marad forró a lakás éjjel is?',
      description: 'Növekvő érdeklődés, kevés érthető magyarázat. Kapcsolódik a városi hő mintaprojekthez.',
      tags: ['Erős illeszkedés', '31 órás ablak', '4 forrás'],
      horizon: '31 óra',
      momentum: 'Gyorsuló',
      channelFit: '92%',
      whyNow: 'A keresési érdeklődés emelkedik, miközben kevés videó mutatja meg érthetően az esti hőcsapda okát.',
      audiencePromise: 'A néző három vizuális jelből felismeri, miért nem hűl vissza a saját lakása.',
      nextMove: 'Kapcsold a városi hő projekthez, majd zárd le a három fő állítást.',
      accent: 'cyan',
    },
    {
      id: 'felt-temperature',
      lane: 'evidence',
      index: '02',
      title: 'Mit mér valójában a hőérzet?',
      description: 'A nézők összekeverik a levegő és a felületek hőmérsékletét. Erős vizuális összehasonlítás.',
      tags: ['Közönségkérdés', 'Magas tisztázási érték'],
      horizon: '3 nap',
      momentum: 'Stabil',
      channelFit: '86%',
      whyNow: 'A témához sok kérdés, de kevés tiszta fogalmi kapaszkodó kapcsolódik.',
      audiencePromise: 'Egyetlen jelenetben különválik a mért hőmérséklet és a személyes hőérzet.',
      nextMove: 'Építs egy kétoszlopos vizuális próbát, mielőtt megírod a magyarázatot.',
      accent: 'lime',
    },
    {
      id: 'shade-myths',
      lane: 'evidence',
      index: '03',
      title: 'Három árnyékolási tévhit egy percben',
      description: 'Rövid formátumban erős, a fő videó előzeteseként is működhet.',
      tags: ['Rövid videó', 'Tesztelhető nyitás'],
      horizon: '5 nap',
      momentum: 'Korai jel',
      channelFit: '78%',
      whyNow: 'A kapcsolódó hosszú videó előtt alacsony kockázattal tesztelhető a közönség reakciója.',
      audiencePromise: 'Három gyakori megoldásról azonnal kiderül, mikor működik és mikor nem.',
      nextMove: 'Próbáld ki ugyanazt a nyitást számmal és személyes következménnyel.',
      accent: 'coral',
    },
  ],
  entertainment: [
    {
      id: 'worst-flat-viewer',
      lane: 'entertainment',
      index: '01',
      title: 'A világ legrosszabb lakásnézője',
      description: 'Ismerős helyzet, azonnali karakter és fokozható rossz döntések egyetlen rövid ívben.',
      tags: ['Erős karakter', 'Sorozatképes', 'Gyors payoff'],
      horizon: '22 óra',
      momentum: 'Gyorsuló',
      channelFit: '94%',
      whyNow: 'A lakáskeresős helyzet könnyen felismerhető, de a karakter nézőpontja még friss csavart ad.',
      audiencePromise: 'A néző minden ajtónyitásnál előbb sejti a bajt, mint a túl magabiztos főszereplő.',
      nextMove: 'Rövidítsd a második jelenetet, majd tartsd vissza a legerősebb fordítást a végére.',
      accent: 'coral',
    },
    {
      id: 'family-video-call',
      lane: 'entertainment',
      index: '02',
      title: 'Amikor az egész család egyszerre akar segíteni',
      description: 'Gyors karakterváltásokkal és egyre rosszabb tanácsokkal építhető közös élmény.',
      tags: ['Relatálható', 'Ensemble', 'Vágható ritmus'],
      horizon: '4 nap',
      momentum: 'Stabil',
      channelFit: '87%',
      whyNow: 'A közönség számára azonnal dekódolható konfliktus, amely több visszatérő karaktert is elbír.',
      audiencePromise: 'Minden néző felismeri azt az egy családtagot, aki biztosan átveszi a beszélgetést.',
      nextMove: 'Rendeld minden karakterhez a saját belépési hangját és vágási tempóját.',
      accent: 'lime',
    },
    {
      id: 'one-minute-expert',
      lane: 'entertainment',
      index: '03',
      title: 'Egy perc alatt lettem szakértő',
      description: 'Önironikus formátum, amelyben a magabiztosság gyorsabban nő, mint a valódi tudás.',
      tags: ['Önirónia', 'Remixelhető', 'Erős nyitás'],
      horizon: '7 nap',
      momentum: 'Korai jel',
      channelFit: '80%',
      whyNow: 'A túl gyors online magabiztosság kulturálisan felismerhető, és sok témára átültethető.',
      audiencePromise: 'A néző látja a kudarcot közeledni, miközben a karakter egyre biztosabb önmagában.',
      nextMove: 'A nyitásban mutasd meg a végállapotot, majd vágj vissza az első téves lépéshez.',
      accent: 'cyan',
    },
  ],
}
