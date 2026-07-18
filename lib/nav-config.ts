import {
  LayoutDashboard,
  Sparkles,
  Lightbulb,
  Package,
  PenLine,
  Image,
  Search,
  TrendingUp,
  Tags,
  PlayCircle,
  SearchX,
  BarChart3,
  Activity,
  Target,
  Flame,
  Sparkle,
  Layers,
  Calendar,
  Brain,
  Stethoscope,
  UserCircle,
  User,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export interface NavLeaf {
  label: string
  href: string
  icon: LucideIcon
}

export type NavSection =
  | { type: 'link'; id: string; label: string; href: string; icon: LucideIcon }
  | { type: 'group'; id: string; label: string; icon: LucideIcon; items: NavLeaf[] }

// A bal oldali navigáció csoportosított szerkezete. A /dashboard/overview,
// /dashboard/transcript és /dashboard/script-extractor route-ok szándékosan
// nincsenek itt — megmaradnak a kódban, de ebben a fázisban nem szerepelnek
// a fő navigációban (lásd a frontend prémiumosítási terv 1. körét).
export const NAV_SECTIONS: NavSection[] = [
  { type: 'link', id: 'command-center', label: 'Command Center', href: '/dashboard', icon: LayoutDashboard },
  {
    type: 'group',
    id: 'create',
    label: 'Create',
    icon: Sparkles,
    items: [
      { label: 'Ideas', href: '/dashboard/opportunities', icon: Lightbulb },
      { label: 'Video Package', href: '/dashboard/video-package', icon: Package },
      { label: 'Title Studio', href: '/dashboard/title-studio', icon: PenLine },
      { label: 'Thumbnail Studio', href: '/dashboard/thumbnail-studio', icon: Image },
    ],
  },
  {
    type: 'group',
    id: 'research',
    label: 'Research',
    icon: Search,
    items: [
      { label: 'Trends', href: '/dashboard/trend-alerts', icon: TrendingUp },
      { label: 'Keywords', href: '/dashboard/keyword-research', icon: Tags },
      { label: 'Similar Videos', href: '/dashboard/similar-videos', icon: PlayCircle },
      { label: 'Content Gap', href: '/dashboard/content-gap', icon: SearchX },
    ],
  },
  {
    type: 'group',
    id: 'intelligence',
    label: 'Intelligence',
    icon: BarChart3,
    items: [
      { label: 'Channel Audit', href: '/dashboard/channel-audit', icon: Activity },
      { label: 'Competitors', href: '/dashboard/competitors', icon: Target },
      { label: 'Viral Score', href: '/dashboard/viral-score', icon: Flame },
      { label: 'SEO Optimizer', href: '/dashboard/seo-optimizer', icon: Sparkle },
    ],
  },
  {
    type: 'group',
    id: 'workflow',
    label: 'Workflow',
    icon: Layers,
    items: [
      { label: 'Calendar', href: '/dashboard/calendar', icon: Calendar },
      { label: 'Memory', href: '/dashboard/memory', icon: Brain },
      { label: 'Audits', href: '/dashboard/video-audit', icon: Stethoscope },
    ],
  },
  {
    type: 'group',
    id: 'account',
    label: 'Account',
    icon: UserCircle,
    items: [
      { label: 'Profile', href: '/dashboard/profile', icon: User },
      { label: 'Credits & Billing', href: '/dashboard/credits', icon: Zap },
    ],
  },
]

// Egy adott pathname-hez tartozó csoport azonosítója — a Header breadcrumb és
// a Sidebar alapértelmezett nyitott-csoport állapota is ezt használja.
export function findNavSectionForPath(pathname: string): { section: NavSection; item?: NavLeaf } | null {
  for (const section of NAV_SECTIONS) {
    if (section.type === 'link') {
      if (pathname === section.href) return { section }
      continue
    }
    const item = section.items.find(leaf => pathname === leaf.href || pathname.startsWith(`${leaf.href}/`))
    if (item) return { section, item }
  }
  return null
}
