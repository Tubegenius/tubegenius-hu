import CreatorWorkspace from '@/components/dashboard/CreatorWorkspace'
import { findCreatorOpportunity } from '@/lib/creator-opportunity-presentation'

interface CreatePageProps {
  searchParams: Promise<{ starter?: string | string[] }>
}

export default async function CreatePage({ searchParams }: CreatePageProps) {
  const params = await searchParams
  const starterId = typeof params.starter === 'string' ? params.starter : null
  const starter = findCreatorOpportunity(starterId)

  return <CreatorWorkspace creatorLane={starter?.lane} starter={starter} />
}
