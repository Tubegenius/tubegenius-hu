// Editing Pattern Engine 1A-1B: the evidence boundary.
//   * the existing Video Audit is metadata-based and must not claim a frame / cut analysis;
//   * the new module is pure (no network, DB, file system, credit charge) and is not wired into any route,
//     so no live creator video and no production data can reach it.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT_EVIDENCE_PROMPT_GUARD_HU, buildAuditEvidenceBasis, findFrameAnalysisClaims } from '@/lib/editing-pattern/audit-evidence-basis'
import { scoreManualBackend, scoreYouTubeBackend, type Platform, type YouTubeApiData } from '@/lib/video-audit-scoring'

const ROOT = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the metadata-based audit does not claim a frame analysis', () => {
  it('states its basis machine-readably: metadata only, no frame analysis, no editing analysis attached', () => {
    const yt = buildAuditEvidenceBasis({ hasApiData: true, hasBehavioralMetrics: false })
    expect(yt).toMatchObject({ kind: 'metadata_only', frame_analysis_performed: false, editing_analysis_available: false })
    expect(yt.basis_fields).toContain('thumbnail_url_presence')
    expect(yt.basis_fields).not.toContain('frames')
    expect(yt.note_hu).toContain('Képkocka- vagy vágásalapú elemzés nem történt')
    const manual = buildAuditEvidenceBasis({ hasApiData: false, hasBehavioralMetrics: true })
    expect(manual.basis_fields).toContain('user_reported_completion_or_watch_time')
    expect(manual.frame_analysis_performed).toBe(false)
  })

  it('the backend scoring signals and weaknesses never mention frames, cuts or visible content', () => {
    const yt: YouTubeApiData = {
      title: 'Teszt', description: 'x'.repeat(300), duration_seconds: 600, views: 50_000, likes: 3_000, comments: 400,
      published_at: '2026-07-15T18:00:00Z', tags: ['a', 'b', 'c', 'd', 'e'], thumbnail_url: 'https://example.com/t.jpg',
    }
    const texts: string[] = []
    const collect = (scores: Record<string, { signals: string[]; weaknesses: string[] }>) => {
      for (const dim of Object.values(scores)) texts.push(...dim.signals, ...dim.weaknesses)
    }
    for (const platform of ['youtube_long', 'youtube_shorts'] as Platform[]) {
      collect(scoreYouTubeBackend(yt, platform) as never)
      collect(scoreYouTubeBackend({ ...yt, thumbnail_url: undefined, duration_seconds: 20 }, platform) as never)
    }
    for (const platform of ['tiktok', 'instagram_reels', 'facebook_reels'] as Platform[]) {
      collect(scoreManualBackend({ platform, topic: 't', title: 'Teszt', duration_seconds: 45, views: 1000, likes: 50, comments: 5, completion_rate: 0.4, avg_watch_time_seconds: 18 }) as never)
    }
    expect(texts.length).toBeGreaterThan(10)
    for (const t of texts) expect(findFrameAnalysisClaims(t), t).toEqual([])
  })

  it('the claim detector catches frame / cut statements and ignores neutral text', () => {
    expect(findFrameAnalysisClaims('A vágások üteme gyors, a képkockák sötétek.')).toEqual(expect.arrayContaining([expect.any(String)]))
    expect(findFrameAnalysisClaims('A videóban látható jelenetváltás jól működik.').length).toBeGreaterThan(0)
    expect(findFrameAnalysisClaims('A cím erős, a hossz platform-optimális.')).toEqual([])
  })

  it('the interpretation prompt carries the evidence guard, and the template version was bumped with it', () => {
    const route = read('app/api/video-audit/route.ts')
    expect(route).toContain('${AUDIT_EVIDENCE_PROMPT_GUARD_HU}')
    expect(route).toContain("promptTemplateId: 'video_audit_interpretation'")
    expect(route).toContain("promptVersion: 'v2'")
    expect(read('lib/prompts/catalog.ts')).toMatch(/id: 'video_audit_interpretation', version: 'v2'/)
    expect(AUDIT_EVIDENCE_PROMPT_GUARD_HU).toContain('NEM láttad')
  })

  it('the audit response carries the evidence basis', () => {
    expect(read('app/api/video-audit/route.ts')).toContain('evidence_basis: buildAuditEvidenceBasis({ hasApiData, hasBehavioralMetrics })')
  })
})

describe('the Editing Pattern module is pure and isolated', () => {
  const dir = path.join(ROOT, 'lib', 'editing-pattern')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
  const importsOf = (src: string) => [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

  it('imports nothing but its own modules and node:crypto', () => {
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const f of files) {
      for (const imp of importsOf(read(`lib/editing-pattern/${f}`))) {
        expect(imp.startsWith('./') || imp === 'node:crypto', `${f} imports ${imp}`).toBe(true)
      }
    }
  })

  it('has no network, process, environment, file-system, database or credit access', () => {
    for (const f of files) {
      const code = read(`lib/editing-pattern/${f}`).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
      expect(code, f).not.toMatch(/\bfetch\(|XMLHttpRequest|process\.env|child_process|node:fs|node:net|node:http|createClient|\.from\('|chargeFeature|credit/i)
    }
  })

  it('is wired into exactly one place: the audit route uses the evidence-basis module only', () => {
    const referencing: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        const rel = path.relative(ROOT, p).split(path.sep).join('/')
        if (rel.startsWith('lib/editing-pattern/') || rel.startsWith('tests/')) continue
        if (fs.readFileSync(p, 'utf8').includes('editing-pattern')) referencing.push(rel)
      }
    }
    for (const top of ['app', 'components', 'lib']) walk(path.join(ROOT, top))
    expect(referencing).toEqual(['app/api/video-audit/route.ts'])
    expect(read('app/api/video-audit/route.ts')).toMatch(/from '@\/lib\/editing-pattern\/audit-evidence-basis'/)
    expect(read('app/api/video-audit/route.ts')).not.toMatch(/editing-pattern\/(analyzer|job-runner|contract|validate)/)
  })

  it('the test fixtures are fictional: no URL, no video id, no creator name', () => {
    const fixtures = read('tests/support/editing-pattern-fixtures.ts')
    expect(fixtures).not.toMatch(/https?:\/\/|youtube\.com|youtu\.be|googleapis/i)
  })
})
