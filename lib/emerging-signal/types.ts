// lib/emerging-signal/types.ts
// WillViral — Emerging Signal capture, megosztott típusok.
//
// Ez a modul a mar meglevo Opportunity Engine altal MAR lekert
// TrendCandidate[] adatot rogziti a 049-053 signal_* semaba, best-effort,
// nulla uj kulso hivassal. Semmilyen score/snapshot/market-stage/trust
// szamitas nincs itt — kizarolag capture (PFM-2B hatokor).

import type { TrendCandidate } from '@/lib/trend-radar'

export interface EmergingSignalCaptureInput {
  candidates: TrendCandidate[]
  // A meglevo RequestBudgetContext.requestId — mar garantaltan egyedi
  // HTTP requestenkent (lib/youtube-service.ts createRequestBudgetContext).
  requestId: string
}

export type EmergingSignalRunOutcome =
  | 'completed'            // uj vagy retry run, sikeresen vegigfutott
  | 'already_completed'    // ugyanaz a requestId mar egyszer sikeresen befejezodott — tiszta no-op
  | 'already_in_progress'  // egy MASIK hivas EPP MOST dolgozik ugyanazon a requestId-n (parhuzamos run-claim vesztes verseny, vagy egy korabbi 'started' allapotban elakadt sor) — tiszta no-op, nem probal ujra irni
  | 'failed'                // a run (uj vagy retry) hibaval allt meg
  | 'no_candidates'          // a candidates[] ures volt — nincs mit rogziteni, a run megis completed

export interface EmergingSignalCaptureResult {
  outcome: EmergingSignalRunOutcome
  runId: string | null
  clustersCompleted: number
  clustersSkipped: number
  clustersFailed: number
}

export interface FingerprintInput {
  category: string | null | undefined
  candidateTopicEn: string | null | undefined
  candidateTopic: string
  seedKeyword: string
}

export interface ComputedFingerprint {
  fingerprint: string
  version: number
}
