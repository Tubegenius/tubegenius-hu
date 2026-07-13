// ============================================================
// WILLVIRAL — Niche-felismerés csatorna alapján (onboarding, "niche_discovery" mód)
// ============================================================
// A "Segítsen megtalálni a niche-emet" onboarding mód a csatorna legutóbbi
// videóinak címei + nézettsége alapján javasol 2-4 lehetséges fő irányt —
// NEM választ automatikusan végleges niche-t, csak javaslatot ad (a userre
// vár a kiválasztás, lásd app/api/youtube/discover-niche/route.ts).

import { MODELS } from '@/lib/models'
import { callAIProvider, extractJson } from '@/lib/services/ai-provider-service'
import { resolveChannel, fetchChannelRecentVideos, type ChannelSnapshot } from '@/lib/competitor-tracker'
import { MAIN_CATEGORIES, type MainCategory } from '@/lib/search/search-context'
import type { NicheCandidate } from '@/types'

function buildNicheDiscoveryPrompt(input: { channelTitle: string; videoTitles: { title: string; views: number }[] }): string {
  const categoryList = MAIN_CATEGORIES.map(c => `${c.value} (${c.label})`).join(', ')
  const videoLines = input.videoTitles.map(v => `- "${v.title}" (${v.views.toLocaleString('hu-HU')} megtekintés)`).join('\n')

  return `Egy YouTube csatorna legutóbbi videói alapján javasolj 2-4 lehetséges tartalmi fő irányt (niche-t) a csatornagazdának, aki még keresi a fő fókuszát.

CSATORNA: "${input.channelTitle}"

LEGUTÓBBI VIDEÓK:
${videoLines}

ENGEDÉLYEZETT KATEGÓRIÁK (main_category KIZÁRÓLAG ezek egyike lehet): ${categoryList}

FELADAT:
Elemezd a videócímeket és nézettségi mintázatot, majd javasolj 2-4 KÜLÖNBÖZŐ lehetséges fő irányt. Minden javaslathoz adj:
- main_category: KIZÁRÓLAG a fenti listából egy érték (angol kulcsszó, pl. "tech_ai")
- specific_focus: rövid, konkrét magyar leírás (pl. "otthoni edzés kezdőknek")
- confidence: 0 és 1 közötti szám, mennyire egyértelmű ez az irány a videók alapján
- rationale: 1 mondatos magyar indoklás, miért ez az irány látszik erősnek

Ha a csatorna egyértelműen egy témára fókuszál, adj vissza csak 1-2 magas confidence-ű javaslatot. Ha vegyes/kísérletező a csatorna, adj 3-4 alacsonyabb confidence-ű javaslatot.

Válaszolj KIZÁRÓLAG valid JSON tömbben:
[{"main_category": "...", "specific_focus": "...", "confidence": 0.0, "rationale": "..."}]`
}

export async function discoverChannelNiches(input: {
  channelInput: string
}): Promise<{ snapshot: ChannelSnapshot; candidates: NicheCandidate[] } | { error: string }> {
  const snapshot = await resolveChannel(input.channelInput)
  if (!snapshot) return { error: 'channel_not_found' }
  if (!snapshot.uploadsPlaylistId) return { error: 'no_recent_videos' }

  const recentVideos = await fetchChannelRecentVideos(snapshot.uploadsPlaylistId, 15)
  if (recentVideos.length === 0) return { error: 'no_recent_videos' }

  const prompt = buildNicheDiscoveryPrompt({
    channelTitle: snapshot.title,
    videoTitles: recentVideos.map(v => ({ title: v.title, views: v.viewCount })),
  })

  const aiCall = await callAIProvider({
    model: MODELS.fast,
    maxTokens: 1200,
    messages: [{ role: 'user', content: prompt }],
    promptTemplateId: 'channel_niche_discovery',
    promptVersion: 'v1',
  })

  const rawCandidates = extractJson<{ main_category: string; specific_focus: string; confidence: number; rationale: string }[]>(aiCall.text)
  const validCategoryValues = new Set<string>(MAIN_CATEGORIES.map(c => c.value))

  const candidates: NicheCandidate[] = rawCandidates
    .filter(c => c.specific_focus && c.specific_focus.trim())
    .map(c => ({
      main_category: (validCategoryValues.has(c.main_category) ? c.main_category : 'other') as MainCategory,
      specific_focus: c.specific_focus.trim(),
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
      rationale: c.rationale || '',
    }))

  return { snapshot, candidates }
}
