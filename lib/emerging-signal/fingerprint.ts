// lib/emerging-signal/fingerprint.ts
// WillViral — Emerging Signal capture, determinisztikus cluster fingerprint.
//
// v1 keplet (rogzitve a 050-es migracio fejleceben es a PFM-2A/2B
// jelentesekben):
//
//   fingerprint_input =
//     fingerprint_version + ":" +
//     normalize(category) + ":" +
//     normalize(candidate_topic_en || candidate_topic) + ":" +
//     normalize(seed_keyword)
//
//   fingerprint = SHA-256(fingerprint_input), teljes 64 hex karakteres
//     alakban (256 bit — tobb, mint a sema altal megkovetelt minimum 128 bit).
//
// SZANDEKOSAN NINCS:
//   - honap/idobelyeg a namespace-ben (korabbi PFM-1C terv visszavonva);
//   - AI-alapu entitaskinyeres;
//   - fuzzy/kozeliteo egyezes — az "altman" es a "sam altman" KULONBOZO
//     normalizalt string, a fingerprintjuk NEM egyezik;
//   - kitalalt ertek hianyzo kotelezo komponensre — ha barmelyik kotelezo
//     mezo (category, topic-forras, seed_keyword) ures/hianyzik NORMALIZALAS
//     ELOTT VAGY UTAN, a fuggveny null-t ad vissza (kontrollaltan skipped),
//     nem "unknown"/ures string placeholdert.
//
// Ez a formula szandekosan konzervativ: tobb false-split, kevesebb
// false-merge (MVP-elv, ld. PFM-1C/2A/2B).

import { createHash } from 'crypto'
import { normalizeText, isBlank } from './normalize'
import type { FingerprintInput, ComputedFingerprint } from './types'

export const FINGERPRINT_VERSION = 1

export function computeFingerprint(input: FingerprintInput): ComputedFingerprint | null {
  const topicSource = isBlank(input.candidateTopicEn) ? input.candidateTopic : input.candidateTopicEn

  if (isBlank(input.category) || isBlank(topicSource) || isBlank(input.seedKeyword)) {
    return null
  }

  const normalizedCategory = normalizeText(input.category as string)
  const normalizedTopic = normalizeText(topicSource as string)
  const normalizedSeed = normalizeText(input.seedKeyword)

  // A nyers mezo nem volt ures, de normalizalas utan azza valt (pl. csupa
  // irasjel/szam nelkuli karakter) — ugyanugy kontrolláltan skipped.
  if (isBlank(normalizedCategory) || isBlank(normalizedTopic) || isBlank(normalizedSeed)) {
    return null
  }

  const fingerprintInput = `${FINGERPRINT_VERSION}:${normalizedCategory}:${normalizedTopic}:${normalizedSeed}`
  const fingerprint = createHash('sha256').update(fingerprintInput).digest('hex')

  return { fingerprint, version: FINGERPRINT_VERSION }
}
