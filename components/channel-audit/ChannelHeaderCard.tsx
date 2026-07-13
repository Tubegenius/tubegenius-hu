'use client'

// ============================================================
// WILLVIRAL — Channel Header Card (Channel Audit oldal teteje)
// ============================================================
// Publikus csatorna-identitás kártya — OAuth NÉLKÜL is megjelenik, ha a
// userneknek van megadott/feloldott YouTube csatornája (profiles.youtube_channel_id).
// SOSE állít privát analitikát (CTR/retenció/watch time) — azok az OAuth-
// alapú ChannelAnalyticsSummary szekcióban (a kártya alatt) jelennek meg,
// csak akkor, ha van tényleges OAuth-kapcsolat.

export interface ChannelProfile {
  youtube_channel_id: string | null
  channel_name: string | null
  channel_avatar_url: string | null
  youtube_channel_url: string | null
  youtube_handle: string | null
  subscriber_count: number | null
  total_view_count: number | null
  video_count: number | null
  channel_published_at: string | null
  channel_synced_at: string | null
  channel_connection_type: 'public' | 'oauth' | 'mismatch' | null
}

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(12px)',
}

const CONNECTION_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  public: { label: 'Publikus YouTube-adatok alapján', color: '#93C5FD', bg: 'rgba(59,130,246,0.12)' },
  oauth: { label: 'YouTube-fiókkal összekapcsolva', color: '#4ADE80', bg: 'rgba(34,197,94,0.12)' },
  mismatch: { label: 'Csatorna-eltérés — válaszd ki az aktív csatornát', color: '#FBBF24', bg: 'rgba(245,158,11,0.12)' },
}

function formatCount(n: number | null): string | null {
  if (n == null) return null
  return n.toLocaleString('hu-HU')
}

function formatYear(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return String(d.getFullYear())
}

export default function ChannelHeaderCard({ channel }: { channel: ChannelProfile }) {
  const badge = channel.channel_connection_type ? CONNECTION_BADGE[channel.channel_connection_type] : null
  const subscriberCount = formatCount(channel.subscriber_count)
  const totalViewCount = formatCount(channel.total_view_count)
  const videoCount = formatCount(channel.video_count)
  const foundedYear = formatYear(channel.channel_published_at)
  const syncedLabel = channel.channel_synced_at ? new Date(channel.channel_synced_at).toLocaleDateString('hu-HU') : null

  return (
    <div className="p-5" style={PANEL_STYLE}>
      <div className="flex items-start gap-4 flex-wrap">
        {channel.channel_avatar_url ? (
          <img
            src={channel.channel_avatar_url}
            alt={channel.channel_name || 'Csatorna avatar'}
            className="w-16 h-16 rounded-full object-cover flex-shrink-0"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center font-bold text-xl flex-shrink-0"
            style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}
          >
            {(channel.channel_name || channel.youtube_handle || '?').charAt(0).toUpperCase()}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold truncate" style={{ color: '#F8FAFC' }}>{channel.channel_name || 'YouTube csatorna'}</p>
          {channel.youtube_handle && (
            <a href={channel.youtube_channel_url || '#'} target="_blank" rel="noopener noreferrer" className="text-xs hover:underline" style={{ color: '#94A3B8' }}>
              @{channel.youtube_handle}
            </a>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            {subscriberCount != null && (
              <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Feliratkozó</p>
                <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{subscriberCount}</p>
              </div>
            )}
            {totalViewCount != null && (
              <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Össz. megtekintés</p>
                <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{totalViewCount}</p>
              </div>
            )}
            {videoCount != null && (
              <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Videók száma</p>
                <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{videoCount}</p>
              </div>
            )}
            {foundedYear && (
              <div className="rounded-lg px-3 py-2" style={{ background: '#0A0E18', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-xs mb-0.5" style={{ color: '#94A3B8' }}>Csatorna indult</p>
                <p className="text-sm font-bold" style={{ color: '#F8FAFC' }}>{foundedYear}</p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5 mt-3">
            {badge && (
              <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ color: badge.color, background: badge.bg }}>
                {badge.label}
              </span>
            )}
            {syncedLabel && (
              <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ color: '#94A3B8', background: 'rgba(255,255,255,0.06)' }}>
                Frissítve: {syncedLabel}
              </span>
            )}
          </div>

          <p className="text-xs mt-3" style={{ color: '#64748B' }}>
            A WillViral a csatornád nyilvános YouTube-adatai alapján mutatja ezt az összefoglalót. Ez publikus csatornaadat — a részletes nézettségi elemzés (CTR, megtartás, forgalom) csak YouTube-fiók összekötése után, lejjebb jelenik meg.
          </p>
        </div>
      </div>
    </div>
  )
}
