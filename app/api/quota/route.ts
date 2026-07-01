import { NextResponse } from 'next/server'
import { quotaSummary } from '@/lib/youtube-service'

export async function GET() {
  return NextResponse.json(quotaSummary())
}
