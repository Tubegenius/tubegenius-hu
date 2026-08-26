'use client'

// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI (Local Implementation Phase 4).
//
// Unauthenticated: app/dashboard/layout.tsx already redirects to
// /auth/login server-side before this Client Component ever mounts -- this
// page relies on that existing guard, exactly like every other page under
// app/dashboard/*, and does not re-implement it.
//
// Authenticated-but-not-a-reviewer: the DB (semantic_topic_reviewers
// allowlist) remains the sole source of truth -- this page never guesses at
// authorization itself. It simply calls the existing reviewer API routes;
// a 403 response is rendered as an explicit "Access denied" state by
// ReviewQueueList / ReviewDetail.
//
// SECURITY BOUNDARY: this page and every component under
// components/semantic-topic-reviews/** talk to the backend exclusively via
// fetch() against the existing five reviewer API routes -- never by
// importing anything from lib/semantic-topic/* (which would pull in, or
// risk pulling in, the service-role-only human-review-service.ts). See
// tests/human-review-ui-security.test.ts for the static source-scan proof.
import { useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import ReviewQueueList from '@/components/semantic-topic-reviews/ReviewQueueList'
import ReviewDetail from '@/components/semantic-topic-reviews/ReviewDetail'

export default function SemanticTopicReviewsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const reviewRequestId = searchParams.get('id')

  const openReview = useCallback(
    (id: string) => {
      router.push(`/dashboard/semantic-topic-reviews?id=${id}`)
    },
    [router],
  )

  const backToList = useCallback(() => {
    router.push('/dashboard/semantic-topic-reviews')
  }, [router])

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>
          🧑‍⚖️ Semantic Topic felülvizsgálat
        </h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>
          Emberi felülvizsgálatra váró candidate topic jelöltek -- jóváhagyás nem hajt végre semmit automatikusan, csak elutasítás hoz létre azonnal végleges döntést.
        </p>
      </div>

      {reviewRequestId ? <ReviewDetail key={reviewRequestId} reviewRequestId={reviewRequestId} onBack={backToList} /> : <ReviewQueueList onOpen={openReview} />}
    </div>
  )
}
