import type { LucideIcon } from 'lucide-react'

interface AppIconProps {
  icon: LucideIcon
  className?: string
  strokeWidth?: number
}

// Egységes wrapper a lucide-react ikonokhoz — az új, prémiumosított
// komponensek (Sidebar, Header, Command Center, Setup flow) mind ezen
// keresztül renderelik az ikonjaikat, hogy a méret/stroke konzisztens legyen.
export default function AppIcon({ icon: Icon, className = 'w-5 h-5', strokeWidth = 1.75 }: AppIconProps) {
  return <Icon className={className} strokeWidth={strokeWidth} aria-hidden="true" />
}
