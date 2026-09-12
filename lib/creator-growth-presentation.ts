import type { CreatorLane } from '@/lib/creator-lane-presentation'

export type CreatorGrowthLens = 'release' | 'pattern'

export interface CreatorGrowthSignal {
  label: string
  value: string
  context: string
}

export interface CreatorGrowthSnapshot {
  lensLabel: string
  title: string
  metricValue: string
  metricLabel: string
  comparison: string
  chartLabel: string
  chartPoints: readonly number[]
  keyMoment: string
  keyMomentDetail: string
  audienceMemory: string
  audienceMemoryDetail: string
  nextTest: string
  nextTestDetail: string
  signals: readonly CreatorGrowthSignal[]
}

export const CREATOR_GROWTH_PRESENTATION: Record<CreatorLane, Record<CreatorGrowthLens, CreatorGrowthSnapshot>> = {
  evidence: {
    release: {
      lensLabel: 'Legutóbbi videó',
      title: 'Miért marad forró a lakás éjjel is?',
      metricValue: '74%',
      metricLabel: 'első 30 mp megtartás',
      comparison: '+8,4 pont a szemléltető csatornaátlaghoz képest',
      chartLabel: 'Szemléltető nézőmegtartási görbe, kiemelve a bizonyíték megmutatásának pillanatát',
      chartPoints: [100, 92, 86, 79, 74, 71, 69, 65, 61, 59, 56, 54],
      keyMoment: 'A bizonyíték megmutatása',
      keyMomentDetail: 'Itt lassult le leginkább a figyelemvesztés: a néző előbb látta a különbséget, és csak utána kapta meg a magyarázatot.',
      audienceMemory: '„Mutasd meg, aztán magyarázd.”',
      audienceMemoryDetail: 'A szemléltető minta szerint a közönség erősebben marad, ha az állítás vizuális következménye korán megjelenik.',
      nextTest: 'Ugyanaz az ígéret, két nyitás',
      nextTestDetail: 'Teszteld egyszer számmal, egyszer személyes következménnyel. A bizonyítékblokk mindkét változatban maradjon azonos.',
      signals: [
        { label: 'Első törés', value: '0:08', context: 'a kontextus előtt' },
        { label: 'Erős pillanat', value: '0:21', context: 'vizuális bizonyíték' },
        { label: 'Visszatérők', value: '38%', context: 'szemléltető arány' },
      ],
    },
    pattern: {
      lensLabel: 'Csatornaminta',
      title: 'A legerősebb magyarázó szerkezeted',
      metricValue: '3/4',
      metricLabel: 'videóban ismétlődő minta',
      comparison: 'A vizuális összehasonlítás következetesen korai figyelmi kapaszkodó',
      chartLabel: 'Szemléltető csatornaminta négy videó normalizált megtartásából',
      chartPoints: [100, 94, 88, 83, 78, 76, 73, 70, 68, 66, 63, 61],
      keyMoment: 'Konkrét különbség az első harmadban',
      keyMomentDetail: 'A minta ott stabilizálódik, ahol a videó egy általános állítás helyett látható összehasonlítást ad.',
      audienceMemory: 'A közönséged a tiszta kontrasztot ismeri fel',
      audienceMemoryDetail: 'Ez még szemléltető hipotézis; valós csatornaállításhoz több publikált videó és egységes mérési ablak szükséges.',
      nextTest: 'Egy állítás, három vizuális próba',
      nextTestDetail: 'A következő projektben ne a téma változzon, hanem a bizonyíték megjelenítési módja.',
      signals: [
        { label: 'Vizsgált videó', value: '4', context: 'szemléltető minta' },
        { label: 'Közös szerkezet', value: '3', context: 'korai kontraszt' },
        { label: 'Bizonyosság', value: 'Korai', context: 'további adat kell' },
      ],
    },
  },
  entertainment: {
    release: {
      lensLabel: 'Legutóbbi videó',
      title: 'A világ legrosszabb lakásnézője',
      metricValue: '68%',
      metricLabel: 'első 30 mp megtartás',
      comparison: '+11,2 pont a szemléltető csatornaátlaghoz képest',
      chartLabel: 'Szemléltető nézőmegtartási görbe, kiemelve a második karakter belépését',
      chartPoints: [100, 90, 82, 75, 71, 68, 70, 66, 64, 61, 60, 58],
      keyMoment: 'A második karakter belépése',
      keyMomentDetail: 'A váratlan belépés rövid figyelmi visszapattanást hozott. A karakterváltás itt nem dísz, hanem ritmikai fordulat.',
      audienceMemory: '„Mindig lehet még rosszabb.”',
      audienceMemoryDetail: 'A szemléltető minta szerint a néző a fokozódó rossz döntések ígéretére marad, nem magára a lakásnézés témájára.',
      nextTest: 'Ugyanaz a jelenet, két vágási ritmus',
      nextTestDetail: 'Az első változatban hagyd meg a reakciószünetet, a másodikban vágj azonnal a következő rossz döntésre.',
      signals: [
        { label: 'Első törés', value: '0:06', context: 'hosszú felvezetés' },
        { label: 'Visszapattanás', value: '0:18', context: 'karakterbelépés' },
        { label: 'Újranézés', value: '12%', context: 'szemléltető arány' },
      ],
    },
    pattern: {
      lensLabel: 'Csatornaminta',
      title: 'A legerősebb élményritmusod',
      metricValue: '4/5',
      metricLabel: 'videóban működő fokozás',
      comparison: 'A második fordulat előtt hagyott rövid csend felismerhető ritmikai jel',
      chartLabel: 'Szemléltető csatornaminta öt videó normalizált megtartásából',
      chartPoints: [100, 91, 84, 78, 73, 75, 70, 69, 65, 63, 61, 59],
      keyMoment: 'Fordulat a második harmad előtt',
      keyMomentDetail: 'A közös minta egy rövid várakozást követő új szereplő vagy következmény. Ez tartja mozgásban az élményígéretet.',
      audienceMemory: 'A közönséged a fokozódást várja',
      audienceMemoryDetail: 'Ez szemléltető hipotézis, nem tényállítás. Valós mintához egységesen címkézett publikációs előzmény kell.',
      nextTest: 'Egy payoff, három odavezető ritmus',
      nextTestDetail: 'A következő projektben a végpont maradjon azonos, csak a köztes fordulatok sűrűségét változtasd.',
      signals: [
        { label: 'Vizsgált videó', value: '5', context: 'szemléltető minta' },
        { label: 'Közös ritmus', value: '4', context: 'fokozódó fordulat' },
        { label: 'Bizonyosság', value: 'Korai', context: 'további adat kell' },
      ],
    },
  },
}
