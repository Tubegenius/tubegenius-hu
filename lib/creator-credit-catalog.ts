export type CreditCatalogGroup = 'create' | 'analyse' | 'research'

export interface CreditCatalogItem {
  key: string
  feature: string
  detail: string
  cost: number
  group: CreditCatalogGroup
  route: string
}

// Kliensbiztos prezentációs katalógus. Szándékosan nem importálja a
// credentialt/admin klienst is betöltő lib/credits.ts modult. Az egyezést
// célzott forrásteszt őrzi.
export const CREATOR_CREDIT_COSTS: readonly CreditCatalogItem[] = [
  { key: 'video_package_shorts', feature: 'Gyártási csomag · Shorts', detail: 'Rövid videó teljes alkotói váza', cost: 2, group: 'create', route: '/dashboard/video-package' },
  { key: 'video_package_long', feature: 'Gyártási csomag · Long', detail: 'Hosszú videó teljes alkotói váza', cost: 6, group: 'create', route: '/dashboard/video-package' },
  { key: 'title_studio', feature: 'Címstúdió', detail: 'Öt értékelt címirány', cost: 1, group: 'create', route: '/dashboard/title-studio' },
  { key: 'thumbnail_studio', feature: 'Thumbnail-stúdió', detail: 'Három vizuális koncepció', cost: 1, group: 'create', route: '/dashboard/thumbnail-studio' },
  { key: 'seo_optimizer', feature: 'Publish Kit', detail: 'Cím, leírás, tagek és publikálási csomag', cost: 1, group: 'create', route: '/dashboard/seo-optimizer' },
  { key: 'video_audit', feature: 'Videódiagnózis', detail: 'Kreatív és teljesítménydöntések elemzése', cost: 4, group: 'analyse', route: '/dashboard/video-audit' },
  { key: 'channel_audit', feature: 'Csatornaaudit-javaslatok', detail: 'Auditmintákból következő videóirányok', cost: 2, group: 'analyse', route: '/dashboard/channel-audit' },
  { key: 'viral_score', feature: 'Virális esély', detail: 'Gyors lehetőségértékelés', cost: 1, group: 'analyse', route: '/dashboard/viral-score' },
  { key: 'script_extract', feature: 'Script Extract', detail: 'Meglévő videóból használható szerkezet', cost: 3, group: 'analyse', route: '/dashboard/script-extractor' },
  { key: 'transcript_extract', feature: 'Auto Transcript', detail: 'Videóból szerkeszthető szövegalap', cost: 3, group: 'analyse', route: '/dashboard/transcript' },
  { key: 'content_gap_finder', feature: 'Content Gap', detail: 'Kereslet és tartalmi lefedettség összevetése', cost: 2, group: 'research', route: '/dashboard/content-gap' },
  { key: 'keyword_research', feature: 'Kulcsszókutatás', detail: 'Keresési irányok feltárása', cost: 1, group: 'research', route: '/dashboard/keyword-research' },
  { key: 'competitor_add', feature: 'Versenytárs hozzáadása', detail: 'Csatorna felvétele a figyelésbe', cost: 1, group: 'research', route: '/dashboard/competitors' },
  { key: 'outlier_scan', feature: 'Versenytárs-frissítés', detail: 'Új kiugró teljesítmények keresése', cost: 1, group: 'research', route: '/dashboard/competitors' },
  { key: 'trend_deep_refresh', feature: 'Trend mély frissítés', detail: 'Új videójelek és webes források', cost: 1, group: 'research', route: '/dashboard' },
  { key: 'niche_discovery_refresh', feature: 'Niche újraelemzése', detail: 'A csatorna besorolásának frissítése', cost: 1, group: 'research', route: '/dashboard/profile' },
  { key: 'opportunity_explain', feature: 'Lehetőség új megközelítése', detail: 'Alternatív feldolgozási szög', cost: 1, group: 'research', route: '/dashboard/opportunities' },
] as const

export const CREATOR_SEARCH_ALLOWANCES = [
  { key: 'opportunity_weekly', feature: 'Videólehetőség-keresés', included: 'Heti első futtatás', paid: 'További keresés: 2 kredit' },
  { key: 'market_evidence_daily', feature: 'Piaci bizonyíték keresés', included: 'Napi első 3 futtatás', paid: 'További keresés: 1 kredit' },
] as const
