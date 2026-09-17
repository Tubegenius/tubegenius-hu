export type CreatorOSSectionId = 'today' | 'discover' | 'create' | 'library' | 'growth'

export interface CreatorOSNavItem {
  id: CreatorOSSectionId
  label: string
  href: string
  paths: readonly string[]
}

export const CREATOR_OS_NAV_ITEMS: readonly CreatorOSNavItem[] = [
  {
    id: 'today',
    label: 'Ma',
    href: '/dashboard',
    paths: ['/dashboard'],
  },
  {
    id: 'discover',
    label: 'Felfedezés',
    href: '/dashboard/discover',
    paths: ['/dashboard/discover'],
  },
  {
    id: 'create',
    label: 'Alkotás',
    href: '/dashboard/create',
    paths: [
      '/dashboard/create',
      '/dashboard/video-package',
      '/dashboard/title-studio',
      '/dashboard/thumbnail-studio',
      '/dashboard/seo-optimizer',
    ],
  },
  {
    id: 'library',
    label: 'Tartalmak',
    href: '/dashboard/library',
    paths: ['/dashboard/library', '/dashboard/memory', '/dashboard/calendar'],
  },
  {
    id: 'growth',
    label: 'Növekedés',
    href: '/dashboard/growth',
    paths: [
      '/dashboard/growth',
      '/dashboard/channel-audit',
      '/dashboard/video-audit',
    ],
  },
] as const

function pathMatches(pathname: string, candidate: string): boolean {
  if (candidate === '/dashboard') return pathname === candidate
  return pathname === candidate || pathname.startsWith(`${candidate}/`)
}

export function creatorOSSectionForPath(pathname: string): CreatorOSSectionId | null {
  for (const item of CREATOR_OS_NAV_ITEMS) {
    if (item.paths.some(path => pathMatches(pathname, path))) return item.id
  }
  return null
}
