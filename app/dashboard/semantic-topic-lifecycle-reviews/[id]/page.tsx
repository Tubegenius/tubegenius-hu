import LifecycleReviewDetail from '@/components/semantic-topic-lifecycle-reviews/LifecycleReviewDetail'

export default async function SemanticTopicLifecycleReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <LifecycleReviewDetail reviewRequestId={id} />
}
