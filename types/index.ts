// ============================================================
// WILLVIRAL — Type Definitions v2
// ============================================================

export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'facebook'
export type Language = 'hu' | 'en'
export type CreatorLevel = 'beginner' | 'growing' | 'advanced' | 'professional'
export type VideoLength = 'short' | 'medium' | 'long'
export type TopicState = 'saved' | 'in_progress' | 'completed' | 'rejected'
export type Region = 'HU' | 'US' | 'BOTH'
export type ChannelUsageMode = 'primary_profile' | 'stats_only' | 'niche_discovery' | 'manual'
export type ChannelConnectionType = 'public' | 'oauth' | 'mismatch'
export type Market = 'HU' | 'CEE' | 'US' | 'UK' | 'DE' | 'GLOBAL_EN' | 'LATAM'
export type Currency = 'HUF' | 'EUR' | 'USD' | 'GBP'
export type VideoIdeaWorkflowStatus =
  | 'new_idea'
  | 'validating'
  | 'validated'
  | 'ready_to_produce'
  | 'scheduled'
  | 'published'
  | 'audited'
  | 'rejected'
  | 'archived'

export type NarrationStyle =
  | 'mrbeast'
  | 'bright_side'
  | 'dylan_page'
  | 'dokumentarista'
  | 'tenyfeltaro'
  | 'tudomanyos'
  | 'storytelling'
  | 'mrballen'
  | 'magyar_tiktok'
  | 'sajat'

export const NARRATION_STYLES: { value: NarrationStyle; label: string; desc: string }[] = [
  { value: 'mrbeast', label: 'MrBeast', desc: 'Energikus, gyors, challenge-alapú' },
  { value: 'bright_side', label: 'Bright Side', desc: 'Informatív, pozitív, listicle' },
  { value: 'dylan_page', label: 'Dylan Page', desc: 'Laza, pletykás, közvetlen' },
  { value: 'dokumentarista', label: 'Dokumentarista', desc: 'Mély, részletes, hiteles' },
  { value: 'tenyfeltaro', label: 'Tényfeltáró', desc: 'Investigatív, drámai, leleplező' },
  { value: 'tudomanyos', label: 'Tudományos', desc: 'Pontos, magyarázó, adatalapú' },
  { value: 'storytelling', label: 'Storytelling', desc: 'Narratív, érzelmes, karakterközpontú' },
  { value: 'mrballen', label: 'MrBallen', desc: 'Misztikus, feszültségépítő, noir' },
  { value: 'magyar_tiktok', label: 'Magyar TikTok', desc: 'Rövid, ütős, trending' },
  { value: 'sajat', label: 'Saját stílus', desc: 'Egyéni prompt megadásával' },
]

// ============================================================
// USER & PROFILE
// ============================================================

export interface NicheCandidate {
  main_category: string
  specific_focus: string
  confidence: number
  rationale: string
}

export interface CreatorProfile {
  id: string
  user_id: string
  channel_name: string | null
  platform: Platform
  language: Language
  niche: string
  main_category: string | null
  specific_focus: string | null
  audience: string | null
  avoid_topics: string | null
  video_length: VideoLength
  creator_level: CreatorLevel
  youtube_channel_id: string | null
  subscriber_count: number | null
  region: Region
  narration_style: NarrationStyle
  custom_prompt: string | null
  onboarding_completed: boolean
  // Csatorna-első onboarding + channel_usage_mode (migráció 029)
  channel_usage_mode: ChannelUsageMode
  youtube_channel_url: string | null
  youtube_handle: string | null
  channel_avatar_url: string | null
  channel_published_at: string | null
  total_view_count: number | null
  video_count: number | null
  channel_synced_at: string | null
  last_channel_audit_at: string | null
  detected_niche_candidates: NicheCandidate[] | null
  niche_confidence: number | null
  selected_main_niche: string | null
  active_channel_id: string | null
  channel_connection_type: ChannelConnectionType | null
  created_at: string
  updated_at: string
}

// ============================================================
// OPPORTUNITY ENGINE
// ============================================================

// niche_based: a niche STRATEGIAI IRANY, sose direkt kereso-query — kotelezo
// niche expansion + validacio. specific_topic: a topic mar kozel-direkt
// validacios query lehet, a profil niche-e nem torzithatja el. discovery_random:
// nincs kotelezo user-inputolt niche/topic, a rendszer a creator profil/
// csatorna-jelek alapjan valaszt kiindulasi iranyt, de meg mindig validalt
// eredmenyt ad, nem vak randomot.
export type OpportunitySearchMode = 'niche_based' | 'specific_topic' | 'discovery_random'

export interface OpportunityTopic {
  id: string
  title: string
  description: string
  opportunity_score: number
  score_breakdown: OpportunityScoreBreakdown
  region: Region
  platform: Platform
  niche: string
  generated_at: string
  expires_at: string
  evidence_videos?: SimilarVideo[]
  web_sources?: Array<{ title: string; url: string; snippet?: string; date?: string; source?: string }>
  confidence?: 'magas' | 'közepes' | 'alacsony' | 'nagyon_alacsony'
  keyword?: string
  niche_cluster?: string
  trend_source_type?: string
  trend_source_label?: string
  hook_suggestion?: string
  user_input?: string
  expanded_from_query?: string
  expansion_type?: string
  expansion_intent?: string
  story_potential_score?: number
  story_potential_breakdown?: {
    total: number
    mystery_factor: number
    twist_strength: number
    human_element: number
    conflict_or_tension: number
    narrative_payoff: number
    visual_story_potential: number
  }
  recommended_angle?: string
  recommended_format?: string
  hook_pattern?: string
  ready_to_produce_status?: 'ready' | 'watch' | 'research' | 'rejected'
  ready_to_produce_label?: string
  evidence_strength?: 'strong' | 'medium' | 'weak' | 'none'
  validation_reason?: string
  recommended_next_action?: 'generate_package' | 'deep_refresh' | 'open_similar_videos' | 'refine_topic' | 'reject'
  data_limitations?: string[]
  evidence_match_score?: number
  risk_flags?: string[]
  decision_score?: number
  topic_consistency_score?: number
  topic_consistency_status?: string
  trend_confidence?: string
  validation_summary?: {
    validation_type: string
    web_validation_score: number
    video_validation_score: number
    content_gap_score: number
    freshness_score: number
    topic_consistency_score: number
    final_decision: string
    explanation: string
    label: string
    evidence_strength?: 'strong' | 'medium' | 'weak' | 'none'
    validation_reason?: string
    recommended_next_action?: 'generate_package' | 'deep_refresh' | 'open_similar_videos' | 'refine_topic' | 'reject'
    data_limitations?: string[]
    cta_primary: { text: string; action: string }
    cta_secondary?: { text: string; action: string }
  }
  safe_output?: {
    headline: string
    explanation: string
    hook: string | null
    hook_status: 'generated' | 'blocked'
    blocked_reason?: string
    dashboard_label: string
    detail_label: string
    ctas: Array<{ text: string; action: string }>
    risk_flags: string[]
  }
  engine_version?: string
  needs_explanation?: boolean
}

export type FeedbackType = 'save' | 'reject' | 'complete' | 'request_similar' | 'request_different'

export const REJECT_REASONS = [
  'Nem illik a csatornámhoz',
  'Túl komoly',
  'Túl unalmas',
  'Túl sokan feldolgozták',
  'Túl nehéz megcsinálni',
  'Nem elég aktuális',
  'Nem érzem virálisnak',
  'Már csináltam hasonlót',
  'Egyéb',
] as const

export type RejectReason = typeof REJECT_REASONS[number]

export interface OpportunityScoreBreakdown {
  trend_momentum: number    // 30% (web validation)
  niche_match: number       // 20% (niche fit)
  content_gap: number       // 20%
  competition: number       // 15% (inverse video engagement)
  freshness: number         // 15%
  total: number
  // Diagnosztikai aldimenziók (opcionális, tooltip / részletes nézethez)
  trend_velocity?: number
  engagement_rate?: number
  view_outlier?: number
  upload_density?: number
  search_relevance?: number
}

export const SCORE_LABELS = {
  trend_momentum: 'Trend Lendület',
  niche_match: 'Niche Illeszkedés',
  content_gap: 'Tartalmi Rés',
  competition: 'Verseny',
  freshness: 'Frissesség',
}

// ============================================================
// VIRAL SCORE
// ============================================================

export interface ViralScoreResult {
  topic: string
  score: number
  confidence: ViralScoreConfidence
  video_count: number
  breakdown: ViralScoreBreakdown
  recommendation: string
  verdict: 'strong' | 'moderate' | 'weak' | 'avoid'
  decision_status?: 'make_now' | 'test_angle' | 'research' | 'avoid'
  decision_label?: string
  decision_reason?: string
  next_action?: string
  risk_flags?: string[]
  videos?: SimilarVideo[]
  web_sources?: { title: string; url: string; source?: string; date?: string }[]
  from_cache?: boolean
  cache_status?: 'fresh' | 'stale_saved' | 'miss'
  last_analyzed_at?: string
  requires_credit?: boolean
}

export interface ViralScoreBreakdown {
  avg_views: number
  avg_likes: number
  avg_comments: number
  trend_momentum: number
  competition_level: number
  // null = a Serper webes jel nem volt elérhető ehhez a futtatáshoz (API hiba/kulcs
  // hiánya) — ilyenkor a score az eredeti, csak YouTube-alapú súlyozással készült.
  web_buzz: number | null
  // Magyarázható score-bontás (Creator OS terv) — miért ez a fő score, nem csak mi.
  freshness?: number
  proof_strength?: number
  niche_fit?: number | null
  risk_level?: 'low' | 'medium' | 'high'
  hook_potential?: number
  audience_curiosity?: number
  platform_fit?: number
  production_difficulty?: number
}

export type ViralScoreConfidence = 'magas' | 'közepes' | 'alacsony' | 'nagyon_alacsony'

// ============================================================
// SIMILAR VIDEOS
// ============================================================

export interface SimilarVideo {
  video_id: string
  title: string
  channel_title: string
  thumbnail_url: string
  view_count: number
  like_count: number
  comment_count: number
  published_at: string
  url: string
  duration: string | null
}

// ============================================================
// SCRIPT EXTRACTOR
// ============================================================

export interface ScriptExtractResult {
  video_id: string
  title: string
  channel: string
  hook: string
  structure: ScriptSection[]
  key_points: string[]
  raw_transcript: string | null
  word_count: number
  estimated_duration: string
}

export interface ScriptSection {
  timestamp: string
  label: string
  content: string
  type: 'intro' | 'hook' | 'main' | 'cta' | 'outro'
}

// ============================================================
// CREATOR MEMORY
// ============================================================

export interface CreatorMemoryItem {
  id: string
  user_id: string
  video_idea_id?: string | null
  topic: string
  search_keyword?: string | null
  platform?: string | null
  state: TopicState
  opportunity_score: number | null
  viral_score: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// VIDEO IDEA — Creator OS kozponti objektum
// ============================================================

export interface VideoIdea {
  id: string
  user_id: string
  title: string
  topic: string
  short_description: string | null
  niche: string | null
  platform: string | null
  language: string | null
  market: string | null
  country: string | null
  currency: string | null
  timezone: string | null
  content_format: string | null
  keywords: unknown[]
  trend_signals: unknown[]
  similar_videos: unknown[]
  competitor_proof: unknown[]
  source_links: unknown[]
  viral_score: number | null
  opportunity_score: number | null
  competition_score: number | null
  risk_factors: unknown[]
  proof_summary: string | null
  title_ideas: unknown[]
  hook_ideas: unknown[]
  thumbnail_concepts: unknown[]
  video_package_id: string | null
  audit_result_id: string | null
  calendar_status: string | null
  scheduled_publish_date: string | null
  calendar_notes: string | null
  publish_status: string | null
  workflow_status: VideoIdeaWorkflowStatus
  paid_result_reference: string | null
  input_hash: string | null
  created_at: string
  updated_at: string
}

export interface VideoIdeaProofSignal {
  id: string
  video_idea_id: string
  user_id: string
  signal_type: 'similar_video' | 'competitor_video' | 'web_source' | 'trend_signal' | 'keyword_signal' | 'transcript' | 'manual_note'
  source_tool: string | null
  source_id: string | null
  title: string | null
  url: string | null
  channel_title: string | null
  published_at: string | null
  view_count: number | null
  relevance_score: number | null
  strength: 'strong' | 'medium' | 'weak' | 'rejected' | null
  reason: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface VideoIdeaEvent {
  id: string
  video_idea_id: string
  user_id: string
  event_type: string
  source_tool: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface MemoryProofSignalSummary {
  strong: number
  medium: number
  weak: number
  rejected: number
  items: Array<{
    signal_type: VideoIdeaProofSignal['signal_type']
    title: string | null
    url: string | null
    strength: VideoIdeaProofSignal['strength']
    source_tool: string | null
  }>
}

export interface MemoryOutcomeMatch {
  topic: string
  workflow_status: VideoIdeaWorkflowStatus
  updated_at: string
  overlap: number
}

export interface MemoryInsight {
  positive?: MemoryOutcomeMatch
  negative?: MemoryOutcomeMatch
}

// ─── Video Package — mentett, visszanézhető generálás ───
export interface VideoPackageRecord {
  id: string
  user_id: string
  video_idea_id?: string | null
  topic: string
  search_keyword?: string | null
  platform: string
  video_length: string
  narration_style?: string | null
  intensity?: string | null
  goal?: string | null
  verified_fact_block?: string | null
  sources: { title: string; url: string }[]
  hook: string
  narration: string
  scene_structure: Array<{ number: number; title: string; duration: string; visual: string; narration: string }>
  broll_ideas: string[]
  timestamps?: string[]
  title_variations: string[]
  thumbnail_texts: string[]
  caption?: string
  description?: string
  hashtags: { viral: string[]; niche: string[]; general: string[] }
  upload_times: { primary: string; secondary: string; reason: string }
  cta: string
  estimated_word_count?: string
  estimated_duration?: string
  created_at: string
  updated_at: string
}

// ============================================================
// API RESPONSES
// ============================================================

export interface ApiResponse<T> {
  data: T | null
  error: string | null
  cached?: boolean
}


// ─── Video Card Actions — egységes videókártya komponens típusai ───
export type VideoSourceContext =
  | 'opportunity_engine'
  | 'similar_videos'
  | 'viral_score'
  | 'video_audit'
  | 'script_extractor'
  | 'trend_evidence'

export interface VideoCardData {
  video_id: string
  title: string
  channel_title: string
  thumbnail_url: string
  video_url: string
  published_at: string
  views: number
  likes: number
  comments: number
  description?: string
  source_context: VideoSourceContext
  decision_status?: 'ready' | 'watch' | 'research' | 'rejected'
  decision_label?: string
  decision_score?: number
  risk_flags?: string[]
  viral_video_score?: number
  relevance_score?: number
  score_breakdown?: Record<string, number>
  reason?: string
}

export interface ExtractedStructure {
  hook: string
  structure: Array<{ timestamp: string; label: string; content: string; type: string }>
  key_points: string[]
  success_factors: string
  estimated_duration: string
  word_count: number
  transcript_available: boolean
  transcript_source: 'transcript' | 'metadata'
}

export interface SourceVideoAnalysis {
  id: string
  user_id: string
  source_video_id: string
  source_video_url: string
  source_video_title: string | null
  source_channel: string | null
  source_context: VideoSourceContext
  transcript_available: boolean
  transcript_source: 'transcript' | 'metadata'
  extracted_structure: ExtractedStructure | Record<string, never>
  verified_fact_block: string | null
  sources: { title: string; url: string }[]
  generated_video_package_id: string | null
  created_at: string
}
