import type { PlatformChecklist } from '@/lib/video-package'
import TagPill from './TagPill'

interface PlatformChecklistCardProps {
  checklist: PlatformChecklist
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>{label}</p>
      <p className="text-sm" style={{ color: '#F8FAFC' }}>{value}</p>
    </div>
  )
}

// Tisztán prezentációs — nincs state, effect, fetch, storage vagy handler.
// A hivatalos PlatformChecklist típust importálja a lib/video-package.ts-ből,
// nem deklarál új vagy harmadik típust. A 4 ág (youtube/tiktok/
// instagram_reels/facebook_reels) szándékosan külön, explicit rows-listát
// épít — nincs mesterséges közös adatmodellre erőltetve, mert a mezők
// platformonként valóban eltérőek.
export default function PlatformChecklistCard({ checklist }: PlatformChecklistCardProps) {
  switch (checklist.type) {
    case 'youtube': {
      const pc = checklist
      const rows: [string, string][] = [
        ['Cím', pc.title],
        ['Kategória', pc.category],
        ['Nyelv', pc.language],
        ['Feliratok', pc.captions_note],
        ['Hozzászólások', pc.comments_setting],
        ['Made for kids', pc.made_for_kids ? `Igen — ${pc.made_for_kids_reason}` : `Nem — ${pc.made_for_kids_reason}`],
        ['Korhatár', pc.age_restriction ? `Igen — ${pc.age_restriction_reason}` : `Nem — ${pc.age_restriction_reason}`],
        ['Licenc', pc.license],
        ['Fizetett promóció', pc.paid_promotion_disclosure ? `Igen — ${pc.paid_promotion_disclosure_note}` : pc.paid_promotion_disclosure_note],
        ['Láthatóság / ütemezés', pc.visibility_schedule_advice],
        ['Lejátszási lista', pc.playlist_suggestion],
        ...(pc.end_screens_plan ? [['Végképernyők', pc.end_screens_plan] as [string, string]] : []),
        ...(pc.cards_plan ? [['Kártyák', pc.cards_plan] as [string, string]] : []),
      ]
      return (
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
          <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>Leírás</p>
            <p className="text-sm whitespace-pre-wrap" style={{ color: '#D1D9E6' }}>{pc.description}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pc.tags.map((tag, i) => (
              <TagPill key={i} variant="platform">{tag}</TagPill>
            ))}
          </div>
        </div>
      )
    }
    case 'tiktok': {
      const pc = checklist
      const rows: [string, string][] = [
        ['Caption', pc.caption],
        ['Borítókép', pc.cover_image_guidance],
        ['Hang', pc.sound_note],
        ['Láthatóság', pc.privacy_setting],
        ['Duet / Stitch / Komment', pc.duet_stitch_comments_settings],
        ['Branded content', pc.branded_content_disclosure],
      ]
      return (
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
          <div className="flex flex-wrap gap-1.5">
            {pc.hashtags.map((tag, i) => (
              <TagPill key={i} variant="platform">{tag}</TagPill>
            ))}
          </div>
        </div>
      )
    }
    case 'instagram_reels': {
      const pc = checklist
      const rows: [string, string][] = [
        ['Caption', pc.caption],
        ['Borítókép', pc.cover_image],
        ['Hang', pc.audio_note],
        ['Alt-text', pc.alt_text],
        ['Megosztás a Feedre', pc.share_to_feed_toggle],
        ['Collab tag', pc.collab_tag_guidance],
        ['Branded content', pc.branded_content_disclosure],
      ]
      return (
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
          <div className="flex flex-wrap gap-1.5">
            {pc.hashtags.map((tag, i) => (
              <TagPill key={i} variant="platform">{tag}</TagPill>
            ))}
          </div>
        </div>
      )
    }
    case 'facebook_reels': {
      const pc = checklist
      const rows: [string, string][] = [
        ['Caption', pc.caption],
        ['Keresztposztolás a Feedre', pc.cross_post_to_feed],
        ['Közönség / láthatóság', pc.audience_visibility],
        ['Zene', pc.music_note],
      ]
      return (
        <div className="space-y-2">
          {rows.map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
        </div>
      )
    }
    default:
      return null
  }
}
