// lib/emerging-signal/capture.ts
// WillViral — Emerging Signal capture orchestration.
//
// Bemenet KIZAROLAG a mar elkeszult TrendCandidate[] es a mar meglevo
// requestId — nincs benne fetch/fetchExternal/YouTube-service/Serper/AI-
// hivas, nincs uj route-hivas, nincs kredit-RPC (ld. lent, "NULLA UJ KULSO
// HIVAS" szekcio es a hozza tartozo statikus import-audit).
//
// A teljes iras NEM egyetlen DB-tranzakcio (a Supabase JS kliens minden
// .from(...).upsert()/insert() hivasa onallo PostgREST-keres, nincs kozos
// tranzakcio kozottuk — ezt szandekosan NEM oldjuk meg uj SECURITY DEFINER
// RPC-vel vagy migracioval ebben a korben). Az atomitas-modellt lasd a
// captureOpportunitySignals() fuggveny doc-kommentjeben.

import { createAdminClient } from '@/lib/supabase-server'
import type { TrendCandidate, VideoWithRelevance, SerperResult } from '@/lib/trend-radar'
import { computeFingerprint } from './fingerprint'
import { isBlank, normalizeCanonicalUrl, extractDomain, safeParseDate } from './normalize'
import type { EmergingSignalCaptureInput, EmergingSignalCaptureResult, EmergingSignalRunOutcome } from './types'
import {
  isUuid,
  toSignalDatabaseError,
  type OperationFailure,
  type SignalAdminClient,
} from './collection-types'

type AdminClient = ReturnType<typeof createAdminClient>

const RUN_TYPE = 'opportunity_side_effect' as const
// Nem erzekeny hiba-kategoriak — SOHA nem nyers hibauzenet/stack trace/
// API-kulcs/prompt/raw payload. Lasd 6. pont (route bekotes) es a
// signal_runs/signal_run_clusters migraciok fejleceben leirt szabalyt.
type ErrorClass = 'db_error' | 'unexpected_error'

function toErrorClass(_e: unknown): ErrorClass {
  // Szandekosan nem vizsgaljuk az `e` tartalmat (nem naplozzuk a message-et
  // vagy stacket) — csak egy fix, nem erzekeny kategoriat adunk vissza.
  return 'db_error'
}

// ── Run idempotency ────────────────────────────────────────────
// A meglevo RequestBudgetContext.requestId-t egy statikus, namespace-elt
// prefixszel latjuk el, hogy a signal_runs.idempotency_key kulcster ne
// utkozzon egy esetleges masik, jovobeli run_type hasznalataval, ha az is
// ugyanazt a nyers requestId-t hasznalna forrasul.
function buildIdempotencyKey(requestId: string): string {
  return `opportunity:${requestId}`
}

interface RunHandle {
  runId: string
  isRetry: boolean
  startedAt: string
}

type RunClaimResult = RunHandle | 'already_completed' | 'already_in_progress' | null

// Run eletciklus — KONTROLLALT ALLAPOTFOGLALAS (PFM-2C korrekcio a
// korabbi upsert+select mintara, ami ket parhuzamos hivast egyszerre
// engedett volna ugyanazon started/failed sor feldolgozasara):
//
//  1) Uj run: sima INSERT status='started'-tal (NEM upsert/ON CONFLICT).
//     Ha ez sikeres, EZ a hivas a sor tulajdonosa — nincs verseny, mert
//     az UNIQUE(idempotency_key) garantalja, hogy legfeljebb egy INSERT
//     sikerulhet ugyanarra a kulcsra.
//  2) Ha az INSERT unique-utkozessel (23505) hasal el, a sor mar letezik
//     — SELECT-tel lekerjuk az allapotat, es agazunk:
//       - completed        -> 'already_completed' (tiszta no-op)
//       - started          -> 'already_in_progress' (egy MASIK hivas MOST
//                              dolgozik rajta — nem nyulunk hozza)
//       - failed           -> FELTETELES UPDATE: SET status='started',
//                              error_class=NULL WHERE id=? AND status='failed'.
//         Postgres ezt a WHERE-t a sor-zar megszerzese UTAN, a LEGFRISSEBB
//         commitolt allapotra ertekeli ki — ha ket hivas verseng ugyanarra
//         a failed sorra, a masodik UPDATE-je (miutan az elso mar
//         commitolt 'started'-re) NULLA sort erint. CSAK az a hivas
//         folytathatja retry-kent, amelynek az UPDATE-je TENYLEGESEN
//         visszaadott egy sort (.select() nem-ures eredmenye) — a vesztes
//         hivas 'already_in_progress'-t kap, NEM probal ujra irni.
//
// DOKUMENTALT KORLAT (nem kotelezo ebben a korben, ld. PFM-2C 3. pont):
// nincs automatikus lease/timeout egy 'started' allapotban ELAKADT (pl.
// a folyamat menet kozben leallt, sosem ert el failed/completed-ig) run-ra
// — egy ilyen sor MINDEN kesobbi, ugyanazzal a requestId-vel erkezo
// hivasra 'already_in_progress'-t ad vissza, amig valaki kezileg nem
// javitja az allapotat. Ez SZANDEKOSAN nincs "megoldva" itt — csak
// dokumentalt, nyitott korlat.
async function ensureRun(admin: AdminClient, requestId: string): Promise<RunClaimResult> {
  const idempotencyKey = buildIdempotencyKey(requestId)

  const { data: inserted, error: insertError } = await admin
    .from('signal_runs')
    .insert({ run_type: RUN_TYPE, idempotency_key: idempotencyKey, status: 'started' })
    .select('id, started_at')
    .single()

  if (!insertError && inserted) {
    return { runId: inserted.id as string, isRetry: false, startedAt: inserted.started_at as string }
  }

  // Csak a vart UNIQUE-utkozes (23505) egy felismert, kezelt allapot — barmi
  // mas varatlan DB-hiba, nem probalunk belole allapotot kitalalni.
  if (!insertError || insertError.code !== '23505') return null

  const { data: existing, error: selectError } = await admin
    .from('signal_runs')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (selectError || !existing) return null

  if (existing.status === 'completed') return 'already_completed'
  if (existing.status === 'started') return 'already_in_progress'

  // existing.status === 'failed' — feltetelesen probaljuk megszerezni a
  // tulajdonjogot. Ha a `data` ures tomb, egy MASIK hivas nyert a versenyben
  // (o mar 'started'-re allitotta, mire ez az UPDATE lefutott) — ez NEM hiba,
  // csak vesztes verseny.
  // completed_at-ot is NULL-ra kell allitani a status='started' atmenettel
  // egyutt — a signal_runs_completed_at_matches_status CHECK
  // (status='started' AND completed_at IS NULL) kombinaciot ir elo, a
  // korabbi 'failed' kiserlet completed_at-ja mast tartalmazna.
  const { data: claimed, error: claimError } = await admin
    .from('signal_runs')
    .update({ status: 'started', error_class: null, completed_at: null })
    .eq('id', existing.id)
    .eq('status', 'failed')
    .select('id, started_at')
  if (claimError) return null
  if (!claimed || claimed.length === 0) return 'already_in_progress'

  return { runId: claimed[0].id as string, isRetry: true, startedAt: claimed[0].started_at as string }
}

// Feltetlen UPDATE, a JELENLEGI statuszra szurve — igy egy mar 'completed'
// sort SOHA nem ir at ez a kod (sem completed->failed, sem completed-nek
// ujra completed-re, redundans modon). Visszaadja, hogy az UPDATE
// TENYLEGESEN hibamentesen lefutott-e — a hivo NEM allithatja, hogy a run
// completed, ha ez az utolso, dontő iras maga hibazott (ld. 6. pont,
// "final completed update" hibainjektalasi pont).
async function finalizeRunCompleted(admin: AdminClient, runId: string): Promise<boolean> {
  // FONTOS: error_class-t is NULL-ra kell allitani — ha ez egy retry egy
  // korabban 'failed' runon, a sor MEG hordozza az elozo kiserlet
  // error_class-at, es a signal_runs_error_class_only_when_failed CHECK
  // (status='failed' OR error_class IS NULL) elutasitana a completed
  // atmenetet, ha az error_class nem NULL-ozodik itt.
  const { error } = await admin
    .from('signal_runs')
    .update({ status: 'completed', completed_at: new Date().toISOString(), error_class: null })
    .eq('id', runId)
    .neq('status', 'completed')
  return !error
}

async function finalizeRunFailed(admin: AdminClient, runId: string, errorClass: ErrorClass): Promise<boolean> {
  const { error } = await admin
    .from('signal_runs')
    .update({ status: 'failed', completed_at: new Date().toISOString(), error_class: errorClass })
    .eq('id', runId)
    .neq('status', 'completed')
  return !error
}

// ── Pure mapping helperek (DB nelkul, kulon unit-tesztelhetok) ──

export interface DerivedYoutubeSourceKey { sourceType: 'youtube_channel'; externalId: string }
export interface DerivedWebSourceKey { sourceType: 'web_domain'; externalId: string; canonicalDomain: string }

// A YouTube source-identitas a TENYLEGESEN rendelkezesre allo channelId
// mezobol szarmazik — ha az ures string (a VideoWithRelevance tipus nem
// opcionalis channelId-t ir elo, DE lib/trend-radar.ts a gyakorlatban
// `channelId: item.snippet.channelId || ''`-t allithat be, ha a YouTube
// API nem adott channelId-t), NINCS ervenyes forrasazonossag — a videot
// KONTROLLÁLTAN kihagyjuk, nem talalunk ki channelId-t.
export function deriveYoutubeSourceKey(video: VideoWithRelevance): DerivedYoutubeSourceKey | null {
  if (isBlank(video.channelId)) return null
  return { sourceType: 'youtube_channel', externalId: video.channelId }
}

// A web source family MVP-ben a canonical domain (ld. normalize.ts) — ha a
// link nem parse-olhato URL, NINCS ervenyes forrasazonossag, a bejegyzest
// kontrolláltan kihagyjuk.
export function deriveWebSourceKey(source: SerperResult): DerivedWebSourceKey | null {
  const domain = extractDomain(source.link)
  if (!domain) return null
  return { sourceType: 'web_domain', externalId: domain, canonicalDomain: domain }
}

export interface EvidenceCandidate {
  evidenceType: 'youtube_video' | 'serper_web'
  externalRef: string
  title: string
  snippet: string | null
  publishedAt: string | null
  canonicalUrl: string | null
}

export function buildYoutubeEvidenceCandidate(video: VideoWithRelevance): EvidenceCandidate | null {
  if (isBlank(video.videoId) || isBlank(video.title)) return null
  return {
    evidenceType: 'youtube_video',
    externalRef: video.videoId,
    title: video.title,
    snippet: video.description || null,
    publishedAt: safeParseDate(video.publishedAt),
    canonicalUrl: null,
  }
}

// FONTOS, DOKUMENTALT KORLAT: a SerperResult tipus (lib/trend-radar.ts) nem
// tartalmaz news/web megkulonbozteto mezot — a TrendCandidate.web_sources
// mar egy egyesitett tomb (Serper News + Serper Web eredmenyek), mire ide
// erkezik, ez az informacio elveszett a hivasi lancban (buildTrendCandidates
// LEPES 1: `serperResults: [...serperNews, ...serperWeb]`). Mivel ez a kor
// KIZAROLAG app/api/opportunity/route.ts-t modosithatja, a trend-radar.ts-t
// nem — ezert MINDEN web forrast 'serper_web' evidence_type-kent rogzitunk
// (ami nem hamis allitas: a tartalom tenyleg Serper-eredetu), a news/web
// alkategoria nem megkulonboztetett. Jovobeli kor nyitott pontja.
export function buildWebEvidenceCandidate(source: SerperResult): EvidenceCandidate | null {
  const canonicalUrl = normalizeCanonicalUrl(source.link)
  if (!canonicalUrl || isBlank(source.link) || isBlank(source.title)) return null
  return {
    evidenceType: 'serper_web',
    externalRef: source.link,
    title: source.title,
    snippet: source.snippet || null,
    publishedAt: safeParseDate(source.date),
    canonicalUrl,
  }
}

export interface ObservationCandidate {
  metricType: 'youtube_view_count' | 'youtube_like_count' | 'youtube_comment_count'
  metricValue: number
}

// Csak TENYLEGES, mar meglevo nyers mertekszamokbol — a VideoWithRelevance
// view/like/comment_count mezoi mindig szamok (nem opcionalisak a
// tipuson), tehat mind a harom mindig irhato. NEM irunk observation-t
// olyan metrikara, aminek nincs megfelelo nyers mezoje a bemeneten (pl.
// Serper evidence-re nem irunk semmit — ld. lent).
export function buildYoutubeObservationCandidates(video: VideoWithRelevance): ObservationCandidate[] {
  const out: ObservationCandidate[] = []
  if (Number.isFinite(video.viewCount) && video.viewCount >= 0) out.push({ metricType: 'youtube_view_count', metricValue: video.viewCount })
  if (Number.isFinite(video.likeCount) && video.likeCount >= 0) out.push({ metricType: 'youtube_like_count', metricValue: video.likeCount })
  if (Number.isFinite(video.commentCount) && video.commentCount >= 0) out.push({ metricType: 'youtube_comment_count', metricValue: video.commentCount })
  return out
}

// SZANDEKOSAN NINCS entitaskinyeres ebben a korben (PFM-2C korrekcio — a
// korabbi deriveCoarseEntities() a topic/seed szabad szoveget irta be
// signal_entities-be `entity_type='other'`, `match_confidence=60` fix
// ertekkel. A 60 NEM mert konfidencia, csak egy kitalalt placeholder —
// felrevezeto lett volna egy jovobeli olvaso szamara, aki azt hihetne,
// hogy tenylegesen 60%-os biztonsagu entitas-egyezesrol van szo). Az
// ELSO shadow writer kizarolag klasztert hoz letre a konzervativ
// topic/seed fingerprintbol — a signal_entities/signal_cluster_members
// tablak ures maradnak, amig egy KESOBBI kor valodi, mert entitas-
// felismerest nem vezet be.

// ── DB upsert helperek — mind termeszetes kulcsra epulo UPSERT, SOHA nem
//    "elobb SELECT majd vak INSERT" ────────────────────────────────────

// Hiba eseten DOB (nem null-t ad vissza) — a hivo egy varatlan DB-hibat
// SOHA nem ertelmezhet ugy, mintha az egy szandekos, kontrolláltan
// kihagyott (business-logic) allapot lenne. A ket eset a hivasi helyen mar
// szet van valasztva: a "nincs ervenyes forrasazonossag" dontes (pl. ures
// channelId) mar deriveYoutubeSourceKey/deriveWebSourceKey szintjen
// megtortenik, MIELOTT ez a fuggveny meghivodna.
async function upsertSource(admin: AdminClient, sourceType: 'youtube_channel' | 'web_domain', externalId: string): Promise<string> {
  const { data, error } = await admin
    .from('signal_sources')
    .upsert(
      { source_type: sourceType, external_id: externalId, source_family_key: externalId, last_seen_at: new Date().toISOString() },
      { onConflict: 'source_type,external_id' }
    )
    .select('id')
    .single()
  if (error || !data) throw new Error('signal_sources upsert failed')
  return data.id as string
}

async function upsertCluster(
  admin: AdminClient,
  params: { primaryLabel: string; category: string | null; fingerprint: string; version: number; createdByRunId: string; firstEvidencePublishedAt: string | null }
): Promise<string | null> {
  const { data, error } = await admin
    .from('signal_clusters')
    .upsert(
      {
        primary_label: params.primaryLabel,
        category: params.category,
        cluster_fingerprint: params.fingerprint,
        fingerprint_version: params.version,
        created_by_run_id: params.createdByRunId,
        first_evidence_published_at: params.firstEvidencePublishedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cluster_fingerprint,fingerprint_version' }
    )
    .select('id')
    .single()
  if (error || !data) return null
  return data.id as string
}

// signal_evidence: KLASZTERFUGGETLEN (054-es migracio — a korabbi
// signal_cluster_id oszlop megszunt, ld. a migracio fejleceben leirt
// indoklast: ugyanaz a video/cikk tobb, kulon klasztert is
// alatamaszthat). Az evidence identitasa (evidence_type, signal_source_id,
// external_ref) mar 051 ota sem tartalmazta a cluster_id-t a UNIQUE
// kulcsban — csak a redundans oszlopot vittuk most at a sajat join
// tablajaba, a sor identitasa nem valtozott. Nincs UPDATE grant (az
// evidence-tartalom szandekosan immutabilis, ld. 051-es migracio), ezert
// `ignoreDuplicates: true` + kulon SELECT az id-ert. Hiba eseten DOB (ld.
// upsertSource fenti magyarazatat — DB-hiba SOHA nem alakulhat at csendes
// "skip"-pe).
async function upsertEvidence(
  admin: AdminClient,
  params: EvidenceCandidate & { sourceId: string; discoveredInRunId: string; youtubeVideosRef: string | null }
): Promise<string> {
  const { error: upsertError } = await admin
    .from('signal_evidence')
    .upsert(
      {
        signal_source_id: params.sourceId,
        evidence_type: params.evidenceType,
        external_ref: params.externalRef,
        youtube_videos_ref: params.youtubeVideosRef,
        title: params.title,
        snippet: params.snippet,
        published_at: params.publishedAt,
        canonical_url: params.canonicalUrl,
        discovered_in_run_id: params.discoveredInRunId,
      },
      { onConflict: 'evidence_type,signal_source_id,external_ref', ignoreDuplicates: true }
    )
  if (upsertError) throw new Error('signal_evidence upsert failed')

  const { data, error } = await admin
    .from('signal_evidence')
    .select('id')
    .eq('evidence_type', params.evidenceType)
    .eq('signal_source_id', params.sourceId)
    .eq('external_ref', params.externalRef)
    .maybeSingle()
  if (error || !data) throw new Error('signal_evidence select failed')
  return data.id as string
}

// signal_cluster_evidence: N:M kapcsolo sor (054-es migracio) — ugyanaz
// az evidence TOBB, kulon klasztert is alatamaszthat (ket join-sor), de
// ugyanahhoz a klaszterhez retry eseten NEM duplikalodik (UNIQUE(
// signal_cluster_id, signal_evidence_id), `ignoreDuplicates: true`).
// Nincs UPDATE/DELETE grant, es a hivo nem hasznalja a join-sor sajat
// id-jet, ezert nincs kulon visszaolvasas. Hiba eseten DOB.
async function upsertClusterEvidence(admin: AdminClient, clusterId: string, evidenceId: string, runId: string): Promise<void> {
  const { error } = await admin
    .from('signal_cluster_evidence')
    .upsert(
      { signal_cluster_id: clusterId, signal_evidence_id: evidenceId, linked_in_run_id: runId, relation_type: 'supports' },
      { onConflict: 'signal_cluster_id,signal_evidence_id', ignoreDuplicates: true }
    )
  if (error) throw new Error('signal_cluster_evidence upsert failed')
}

// bucketStart = a RUN sajat started_at-ja (masodperc-pontossagra vagva),
// NEM `now()` az iras pillanataban — ez garantalja, hogy egy retry
// UGYANAZT a bucket_start-ot szamitja ki, mint az eredeti kiserlet, tehat
// a UNIQUE(signal_evidence_id, metric_type, cadence, bucket_start) termeszetes
// kulcs miatt a retry idempotens marad, nem duplikal uj sort minden
// ujraprobalkozaskor. Hiba eseten DOB.
async function upsertObservation(admin: AdminClient, evidenceId: string, runId: string, bucketStart: string, obs: ObservationCandidate): Promise<void> {
  const { error } = await admin
    .from('signal_observations')
    .upsert(
      {
        signal_evidence_id: evidenceId,
        signal_run_id: runId,
        metric_type: obs.metricType,
        metric_value: obs.metricValue,
        cadence: 'on_demand',
        bucket_start: bucketStart,
      },
      { onConflict: 'signal_evidence_id,metric_type,cadence,bucket_start' }
    )
  if (error) throw new Error('signal_observations upsert failed')
}

// Hiba eseten DOB — a sikeres-ag hivasa (checkStatus:'completed') igy
// resze a candidate atomitas-hatarnak (ld. captureOneCandidate try/catch).
// A catch-ag SAJAT, best-effort hivasa (checkStatus:'failed') EZT a
// dobast egy KULON, belso try/catch-csel nyeli — ld. ott.
async function upsertRunCluster(
  admin: AdminClient,
  params: { runId: string; clusterId: string; inputSummaryHash: string; newEvidenceCount: number; checkStatus: 'completed' | 'failed' | 'skipped'; skipReason: string | null; errorClass: ErrorClass | null }
): Promise<void> {
  const { error } = await admin
    .from('signal_run_clusters')
    .upsert(
      {
        signal_run_id: params.runId,
        signal_cluster_id: params.clusterId,
        input_summary_hash: params.inputSummaryHash,
        new_evidence_found: params.newEvidenceCount > 0,
        new_evidence_count: params.newEvidenceCount,
        check_status: params.checkStatus,
        skip_reason: params.skipReason,
        error_class: params.errorClass,
      },
      { onConflict: 'signal_run_id,signal_cluster_id' }
    )
  if (error) throw new Error('signal_run_clusters upsert failed')
}

// ── Egy candidate teljes capture-je ──────────────────────────────

type CandidateOutcome = 'completed' | 'skipped' | 'failed'

export interface ScheduledDiscoveryVideo {
  videoId: string
  title: string
  description?: string
  channelId: string
  channelTitle: string
  publishedAt: string
}

export type ScheduledDiscoveryCaptureResult =
  | { outcome: 'success'; clusterId: string; evidenceCount: number; scheduledCount: number }
  | OperationFailure

// Background discovery capture uses an already-owned scheduled_enrichment
// run. Unlike captureOpportunitySignals it never creates/finalizes a run and
// never calls a provider. All multi-item writes are batched: no per-video DB
// round trip is permitted on the iad1 <-> eu-west-1 path.
export async function captureScheduledDiscovery(
  input: {
    runId: string
    seedFingerprint: string
    seedText: string
    category: string
    videos: ScheduledDiscoveryVideo[]
    observedAt?: Date
  },
  client?: SignalAdminClient,
): Promise<ScheduledDiscoveryCaptureResult> {
  const operation = 'capture_scheduled_signal_discovery'
  if (!isUuid(input.runId)) return { outcome: 'invalid_request', message: 'runId must be a UUID.' }
  if (!input.seedFingerprint.trim() || input.seedFingerprint.length > 512) {
    return { outcome: 'invalid_request', message: 'seedFingerprint is required and must be at most 512 characters.' }
  }
  if (!input.seedText.trim() || input.seedText.length > 500) {
    return { outcome: 'invalid_request', message: 'seedText is required and must be at most 500 characters.' }
  }
  if (!input.category.trim() || input.category.length > 100) {
    return { outcome: 'invalid_request', message: 'category is required and must be at most 100 characters.' }
  }
  if (!Array.isArray(input.videos) || input.videos.length > 50) {
    return { outcome: 'invalid_request', message: 'videos must contain at most 50 items.' }
  }
  const observedAt = input.observedAt ?? new Date()
  if (!Number.isFinite(observedAt.getTime())) return { outcome: 'invalid_request', message: 'observedAt must be valid.' }

  const byVideoId = new Map<string, ScheduledDiscoveryVideo>()
  for (const video of input.videos) {
    if (
      !video || !/^[A-Za-z0-9_-]{1,100}$/.test(video.videoId) ||
      !video.title?.trim() || video.title.length > 500 ||
      !video.channelId?.trim() || video.channelId.length > 200 ||
      !video.channelTitle?.trim() || video.channelTitle.length > 500 ||
      (video.description !== undefined && video.description.length > 5_000) ||
      !safeParseDate(video.publishedAt) || byVideoId.has(video.videoId)
    ) return { outcome: 'invalid_request', message: 'Discovery videos must be unique and contain valid IDs, source identity, title and publish time.' }
    byVideoId.set(video.videoId, video)
  }

  const fingerprint = computeFingerprint({
    category: input.category,
    candidateTopicEn: null,
    candidateTopic: input.seedText,
    seedKeyword: input.seedText,
  })
  if (!fingerprint) return { outcome: 'invalid_request', message: 'Unable to derive the discovery cluster fingerprint.' }
  const db = client ?? createAdminClient()

  try {
    const published = [...byVideoId.values()].map(video => safeParseDate(video.publishedAt)!).sort()
    const clusterId = await upsertCluster(db, {
      primaryLabel: input.seedText.trim(),
      category: input.category.trim(),
      fingerprint: fingerprint.fingerprint,
      version: fingerprint.version,
      createdByRunId: input.runId,
      firstEvidencePublishedAt: published[0] ?? null,
    })
    if (!clusterId) return { outcome: 'database_error', operation, error: { message: 'Cluster upsert failed.' } }

    const videos = [...byVideoId.values()]
    if (videos.length === 0) {
      await upsertRunCluster(db, {
        runId: input.runId,
        clusterId,
        inputSummaryHash: `scheduled:v${fingerprint.version}:${fingerprint.fingerprint.slice(0, 16)}`,
        newEvidenceCount: 0,
        checkStatus: 'completed',
        skipReason: null,
        errorClass: null,
      })
      return { outcome: 'success', clusterId, evidenceCount: 0, scheduledCount: 0 }
    }

    const { error: videoError } = await db.from('youtube_videos').upsert(
      videos.map(video => ({
        video_id: video.videoId,
        title: video.title.trim(),
        channel_id: video.channelId.trim(),
        channel_title: video.channelTitle.trim(),
        published_at: safeParseDate(video.publishedAt),
        last_seen_at: observedAt.toISOString(),
      })),
      { onConflict: 'video_id' },
    )
    if (videoError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(videoError) }

    const channelMap = new Map<string, string>()
    for (const video of videos) channelMap.set(video.channelId.trim(), video.channelTitle.trim())
    const { data: sourceData, error: sourceError } = await db.from('signal_sources').upsert(
      [...channelMap].map(([externalId, displayName]) => ({
        source_type: 'youtube_channel', external_id: externalId, display_name: displayName,
        source_family_key: externalId, last_seen_at: observedAt.toISOString(),
      })),
      { onConflict: 'source_type,external_id' },
    ).select('id,external_id')
    if (sourceError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(sourceError) }
    if (!Array.isArray(sourceData)) return { outcome: 'invalid_rpc_response', operation }
    const sourceIds = new Map(sourceData.map(row => [String(row.external_id), String(row.id)]))
    if (sourceIds.size !== channelMap.size || [...sourceIds.values()].some(id => !isUuid(id))) {
      return { outcome: 'invalid_rpc_response', operation }
    }

    const evidenceRows = videos.map(video => ({
      signal_source_id: sourceIds.get(video.channelId.trim())!,
      evidence_type: 'youtube_video',
      external_ref: video.videoId,
      youtube_videos_ref: video.videoId,
      title: video.title.trim(),
      snippet: video.description?.trim() || null,
      published_at: safeParseDate(video.publishedAt),
      canonical_url: null,
      discovered_in_run_id: input.runId,
    }))

    // Snapshot the existing natural keys before the insert. A repeated daily
    // discovery may legitimately link old evidence again, but run audit must
    // count only genuinely new evidence as new_evidence_count.
    const { data: evidenceBeforeData, error: evidenceBeforeError } = await db
      .from('signal_evidence')
      .select('signal_source_id,external_ref,discovered_in_run_id')
      .eq('evidence_type', 'youtube_video')
      .in('external_ref', videos.map(video => video.videoId))
    if (evidenceBeforeError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(evidenceBeforeError) }
    if (!Array.isArray(evidenceBeforeData)) return { outcome: 'invalid_rpc_response', operation }
    const existingEvidenceKeys = new Set(
      evidenceBeforeData
        .filter(row => row.discovered_in_run_id !== input.runId)
        .map(row => `${row.signal_source_id}:${row.external_ref}`),
    )

    const { error: evidenceInsertError } = await db.from('signal_evidence').upsert(evidenceRows, {
      onConflict: 'evidence_type,signal_source_id,external_ref', ignoreDuplicates: true,
    })
    if (evidenceInsertError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(evidenceInsertError) }

    const { data: evidenceData, error: evidenceReadError } = await db
      .from('signal_evidence')
      .select('id,signal_source_id,external_ref')
      .eq('evidence_type', 'youtube_video')
      .in('external_ref', videos.map(video => video.videoId))
    if (evidenceReadError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(evidenceReadError) }
    if (!Array.isArray(evidenceData)) return { outcome: 'invalid_rpc_response', operation }
    const expectedKeys = new Set(evidenceRows.map(row => `${row.signal_source_id}:${row.external_ref}`))
    const exactEvidence = evidenceData.filter(row => expectedKeys.has(`${row.signal_source_id}:${row.external_ref}`))
    if (exactEvidence.length !== expectedKeys.size || exactEvidence.some(row => !isUuid(String(row.id)))) {
      return { outcome: 'invalid_rpc_response', operation }
    }
    const evidenceIds = exactEvidence.map(row => String(row.id))

    const { error: linkError } = await db.from('signal_cluster_evidence').upsert(
      evidenceIds.map(evidenceId => ({
        signal_cluster_id: clusterId, signal_evidence_id: evidenceId,
        linked_in_run_id: input.runId, relation_type: 'supports',
      })),
      { onConflict: 'signal_cluster_id,signal_evidence_id', ignoreDuplicates: true },
    )
    if (linkError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(linkError) }

    const { error: scheduleError } = await db.from('signal_observation_schedule').upsert(
      evidenceIds.map(evidenceId => ({ signal_evidence_id: evidenceId })),
      { onConflict: 'signal_evidence_id', ignoreDuplicates: true },
    )
    if (scheduleError) return { outcome: 'database_error', operation, error: toSignalDatabaseError(scheduleError) }

    await upsertRunCluster(db, {
      runId: input.runId,
      clusterId,
      inputSummaryHash: `scheduled:v${fingerprint.version}:${fingerprint.fingerprint.slice(0, 16)}`,
      newEvidenceCount: evidenceRows.filter(
        row => !existingEvidenceKeys.has(`${row.signal_source_id}:${row.external_ref}`),
      ).length,
      checkStatus: 'completed',
      skipReason: null,
      errorClass: null,
    })
    return { outcome: 'success', clusterId, evidenceCount: evidenceIds.length, scheduledCount: evidenceIds.length }
  } catch (error) {
    return { outcome: 'database_error', operation, error: toSignalDatabaseError(error) }
  }
}

async function captureOneCandidate(
  admin: AdminClient,
  candidate: TrendCandidate,
  runId: string,
  bucketStart: string,
  existingYoutubeVideoIds: Set<string>
): Promise<CandidateOutcome> {
  const fp = computeFingerprint({
    category: candidate.category,
    candidateTopicEn: candidate.candidate_topic_en,
    candidateTopic: candidate.candidate_topic,
    seedKeyword: candidate.seed_keyword,
  })
  // Kotelezo fingerprint-komponens hianyzik — kontrolláltan skipped, NEM
  // kap kitalalt erteket. Ehhez meg cluster sem jon letre, tehat
  // signal_run_clusters sort sem tudunk irni ra (nincs cluster_id) — ez a
  // fajta skip NEM jelenik meg run_clusters sorkent, csak a hivo aggregalt
  // szamlalojaban (ld. captureOpportunitySignals).
  if (!fp) return 'skipped'

  // Kivul deklaralva a try-n, hogy a catch-ag is hivatkozhasson ra egy
  // best-effort hiba-audit sorhoz, ujra-upsert nelkul.
  let clusterId: string | null = null

  try {
    const firstPublishedCandidates = candidate.source_videos
      .map(v => safeParseDate(v.publishedAt))
      .filter((d): d is string => d !== null)
    const firstEvidencePublishedAt = firstPublishedCandidates.length > 0
      ? firstPublishedCandidates.sort()[0]
      : null

    clusterId = await upsertCluster(admin, {
      primaryLabel: candidate.candidate_topic,
      category: candidate.category || null,
      fingerprint: fp.fingerprint,
      version: fp.version,
      createdByRunId: runId,
      firstEvidencePublishedAt,
    })
    if (!clusterId) throw new Error('cluster upsert failed')

    // SZANDEKOSAN NINCS entitas/tagsag-iras itt — ld. a
    // deriveCoarseEntities-t felvalto fejlec-kommentet fentebb. Az elso
    // shadow writer kizarolag a klasztert hozza letre, signal_entities/
    // signal_cluster_members uresen marad.

    let newEvidenceCount = 0

    // YouTube evidence + observation
    for (const video of candidate.source_videos) {
      const sourceKey = deriveYoutubeSourceKey(video)
      const evidenceCandidate = buildYoutubeEvidenceCandidate(video)
      if (!sourceKey || !evidenceCandidate) continue // kontrolláltan kihagyva, nincs ervenyes azonossag

      const sourceId = await upsertSource(admin, sourceKey.sourceType, sourceKey.externalId)

      // youtube_videos_ref CSAK akkor toltodik ki, ha a hivatkozott helyi
      // youtube_videos sor tenylegesen letezik — kulonben a FK constraint
      // elutasitana a teljes evidence-sort.
      const youtubeVideosRef = existingYoutubeVideoIds.has(video.videoId) ? video.videoId : null

      const evidenceId = await upsertEvidence(admin, {
        ...evidenceCandidate,
        sourceId,
        discoveredInRunId: runId,
        youtubeVideosRef,
      })
      await upsertClusterEvidence(admin, clusterId, evidenceId, runId)
      newEvidenceCount++

      for (const obs of buildYoutubeObservationCandidates(video)) {
        await upsertObservation(admin, evidenceId, runId, bucketStart, obs)
      }
    }

    // Web (Serper) evidence — nincs per-item nyers metrika a SerperResult
    // tipuson, ezert erre NEM irunk signal_observations sort (ld.
    // buildWebEvidenceCandidate doc-kommentje es a PFM-2B zarojelentes).
    for (const source of candidate.web_sources) {
      const sourceKey = deriveWebSourceKey(source)
      const evidenceCandidate = buildWebEvidenceCandidate(source)
      if (!sourceKey || !evidenceCandidate) continue

      const sourceId = await upsertSource(admin, sourceKey.sourceType, sourceKey.externalId)

      const evidenceId = await upsertEvidence(admin, {
        ...evidenceCandidate,
        sourceId,
        discoveredInRunId: runId,
        youtubeVideosRef: null,
      })
      await upsertClusterEvidence(admin, clusterId, evidenceId, runId)
      newEvidenceCount++
    }

    const inputSummaryHash = `v${fp.version}:${fp.fingerprint.slice(0, 16)}`
    await upsertRunCluster(admin, {
      runId,
      clusterId,
      inputSummaryHash,
      newEvidenceCount,
      checkStatus: 'completed',
      skipReason: null,
      errorClass: null,
    })
    return 'completed'
  } catch (e) {
    // Best-effort audit-sor a hibarol — ha ez az iras is elhasal, a catch
    // itt is nyeli, a candidate-szintu kimenet marad 'failed'.
    try {
      if (clusterId) {
        const inputSummaryHash = `v${fp.version}:${fp.fingerprint.slice(0, 16)}`
        await upsertRunCluster(admin, {
          runId,
          clusterId,
          inputSummaryHash,
          newEvidenceCount: 0,
          checkStatus: 'failed',
          skipReason: null,
          errorClass: toErrorClass(e),
        })
      }
    } catch {
      // teljesen best-effort — ha ez is elhasal, nincs tovabbi teendo
    }
    return 'failed'
  }
}

// ── Fő belépési pont ─────────────────────────────────────────────
//
// ATOMITAS-MODELL (ld. PFM-2B 8. pont):
// A Supabase JS kliens minden .upsert()/.update() hivasa onallo, sajat
// tranzakcio — nincs kozos tranzakcio a teljes capture folyamat felett, es
// ebben a korben szandekosan NEM vezetunk be uj SECURITY DEFINER RPC-t
// vagy migraciot ennek megoldasara. Az idempotencia ehelyett ARRA epul,
// hogy MINDEN egyes iras onmagaban idempotens (termeszetes kulcsra
// UPSERT), es a bucket_start a RUN started_at-jahoz van rogzitve (nem
// `now()`-hoz) — igy egy retry (ugyanazzal a requestId-vel, tehat
// ugyanazzal a signal_runs sorral) biztonsagosan megismetelheti a TELJES
// candidate-listat: a mar sikeresen irt sorok upsert-je no-op-kent
// viselkedik, a korabban meghiusult resz pedig most probal ujra.
//
// Egy candidate FELDOLGOZASA (captureOneCandidate) sajat try/catch-ben fut.
// Ha egy candidate varatlan hibaba utkozik, azt 'failed'-kent rogzitjuk (ha
// lehetseges, egy signal_run_clusters sorral is), ES a teljes run
// 'failed'-re all — "reszleges hiba utan a run failed", "completed csak
// minden szukseges lepes utan" (PFM-2B 8. pont). A hianyzo/ervenytelen
// fingerprint miatti 'skipped' NEM szamit hibanak — az egy kontrollalt,
// varhato allapot, nem allitja meg a tobbi candidate feldolgozasat.
export async function captureOpportunitySignals(input: EmergingSignalCaptureInput): Promise<EmergingSignalCaptureResult> {
  const empty = (outcome: EmergingSignalRunOutcome): EmergingSignalCaptureResult => ({
    outcome, runId: null, clustersCompleted: 0, clustersSkipped: 0, clustersFailed: 0,
  })

  if (!input.requestId) return empty('failed')

  let admin: AdminClient
  try {
    admin = createAdminClient()
  } catch {
    return empty('failed')
  }

  let runHandle: RunClaimResult
  try {
    runHandle = await ensureRun(admin, input.requestId)
  } catch {
    return empty('failed')
  }
  if (runHandle === null) return empty('failed')
  if (runHandle === 'already_completed') return empty('already_completed')
  if (runHandle === 'already_in_progress') return empty('already_in_progress')

  const { runId, startedAt } = runHandle

  if (input.candidates.length === 0) {
    const finalized = await finalizeRunCompleted(admin, runId)
    // Ha maga a lezaro UPDATE hibazik, NEM allithatjuk, hogy a run
    // completed — a hivo nem kaphat hamis "sikeres" jelzest egy olyan
    // sorra, ami valojaban 'started'-ben ragadt (ld. "final completed
    // update" hibainjektalasi pont, 6. pont).
    if (!finalized) return { outcome: 'failed', runId, clustersCompleted: 0, clustersSkipped: 0, clustersFailed: 0 }
    return { outcome: 'no_candidates', runId, clustersCompleted: 0, clustersSkipped: 0, clustersFailed: 0 }
  }

  // Egyetlen, kotegelt SELECT az osszes erintett YouTube video_id-re — ez
  // egy LOKALIS Postgres-olvasas a Supabase kliensen keresztul, NEM kulso
  // API-hivas (ld. 6. pont, statikus import-audit).
  const allVideoIds = Array.from(new Set(
    input.candidates.flatMap(c => c.source_videos.map(v => v.videoId)).filter(id => !isBlank(id))
  ))
  let existingYoutubeVideoIds = new Set<string>()
  if (allVideoIds.length > 0) {
    try {
      const { data } = await admin.from('youtube_videos').select('video_id').in('video_id', allVideoIds)
      existingYoutubeVideoIds = new Set((data || []).map(r => r.video_id as string))
    } catch {
      // Ha ez a lekerdezes hibazik, konzervativan ures halmazzal folytatunk
      // — a youtube_videos_ref egyszeruen NULL marad minden videora
      // (biztonsagos: nem probal FK-t serto erteket irni).
      existingYoutubeVideoIds = new Set()
    }
  }

  // A run SAJAT started_at-ja, masodperc-pontossagra vagva — NEM `now()` az
  // iras pillanataban. Ez garantalja, hogy egy retry (ugyanazzal a
  // requestId-vel, tehat ugyanazzal a signal_runs sorral) UGYANAZT a
  // bucket_start-ot szamitja, mint az eredeti kiserlet.
  const bucketStart = new Date(Math.floor(new Date(startedAt).getTime() / 1000) * 1000).toISOString()

  let completed = 0
  let skipped = 0
  let failed = 0

  for (const candidate of input.candidates) {
    const result = await captureOneCandidate(admin, candidate, runId, bucketStart, existingYoutubeVideoIds)
    if (result === 'completed') completed++
    else if (result === 'skipped') skipped++
    else {
      failed++
      // "reszleges hiba utan a run failed" — az elso varatlan candidate-
      // hiba utan megallunk, nem probalunk tovabbi candidate-eket.
      await finalizeRunFailed(admin, runId, 'unexpected_error')
      return { outcome: 'failed', runId, clustersCompleted: completed, clustersSkipped: skipped, clustersFailed: failed }
    }
  }

  const finalized = await finalizeRunCompleted(admin, runId)
  if (!finalized) return { outcome: 'failed', runId, clustersCompleted: completed, clustersSkipped: skipped, clustersFailed: failed }
  return { outcome: 'completed', runId, clustersCompleted: completed, clustersSkipped: skipped, clustersFailed: failed }
}
