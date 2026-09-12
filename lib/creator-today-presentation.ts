import type { CreatorLane } from '@/lib/creator-lane-presentation'

export interface CreatorTodayPresentation {
  projectTitle: string
  artifactPhase: string
  visualLabel: string
  frameMoment: string
  frameLabel: string
  timelineLabel: string
  timelineState: string
  proofTitle: string
  proofDetail: string
  intelligence: readonly [
    { title: string; detail: string },
    { title: string; detail: string },
    { title: string; emptyDetail: string },
  ]
  opportunities: readonly [
    { title: string; detail: string },
    { title: string; detail: string },
  ]
  tip: string
  tipExample: string
}

export const CREATOR_TODAY_PRESENTATION: Record<CreatorLane, CreatorTodayPresentation> = {
  evidence: {
    projectTitle: 'Miért nem hűt minden városi fa ugyanannyit?',
    artifactPhase: 'Állítások · 2/4',
    visualLabel: 'Szemléltető városi hőtérképes videóképkocka',
    frameMoment: 'Állítás 02 · 04:18',
    frameLabel: 'Lombkorona és felszíni hőmérséklet',
    timelineLabel: 'Magyarázó képsor',
    timelineState: 'Vázlat · 01:24',
    proofTitle: '5 forrás kapcsolódik',
    proofDetail: 'Egy ellenőrzés szükséges',
    intelligence: [
      { title: 'Nyitott lehetőségablak', detail: 'Becsült idő: 31 óra · mintaadat' },
      { title: 'Új megerősítő forrás', detail: 'Az árnyékolás hatásáról' },
      { title: 'Közönségmemória', emptyDetail: 'Az összehasonlítás erős minta' },
    ],
    opportunities: [
      { title: 'A lakások hőcsapdái', detail: 'Erős csatornailleszkedés · minta' },
      { title: 'Mit mér valójában a hőérzet?', detail: 'Friss összehasonlítás · minta' },
    ],
    tip: 'A szám előtt mutasd meg, mit változtat meg a néző életében.',
    tipExample: '„Ez a két fa hat fok különbséget jelenthet.”',
  },
  entertainment: {
    projectTitle: 'A világ legrosszabb lakásnézője',
    artifactPhase: 'Élményív · 2/4',
    visualLabel: 'Szemléltető, gyorsuló lakásnézési jelenetsor',
    frameMoment: 'Fordulat 02 · 00:18',
    frameLabel: 'A második karakter váratlan belépése',
    timelineLabel: 'Jelenetritmus',
    timelineState: 'Vázlat · 00:42',
    proofTitle: '4 élménypont kapcsolódik',
    proofDetail: 'Egy ritmusváltás erősíthető',
    intelligence: [
      { title: 'Nyitott formátumablak', detail: 'Becsült idő: 22 óra · mintaadat' },
      { title: 'Erős karakterpillanat', detail: 'A második belépésnél nő az impulzus' },
      { title: 'Közönségmemória', emptyDetail: 'A fokozódás erős minta' },
    ],
    opportunities: [
      { title: 'Amikor az egész család egyszerre segít', detail: 'Erős karakterdinamika · minta' },
      { title: 'Egy perc alatt lettem szakértő', detail: 'Remixelhető önirónia · minta' },
    ],
    tip: 'A fordulat előtt hagyj egy fél ütemnyi várakozást.',
    tipExample: 'A néző előbb érezze, hogy baj lesz, mint a karakter.',
  },
}
