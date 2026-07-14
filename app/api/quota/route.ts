import { NextResponse } from 'next/server'
import { quotaSummary } from '@/lib/youtube-service'
import { getUserId } from '@/lib/credits'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
  return NextResponse.json(quotaSummary())
}
