export interface LifecycleJsonResponse {
  ok: boolean
  status: number
  payload: unknown
}

export async function requestLifecycleJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<LifecycleJsonResponse> {
  const response = await fetcher(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
  })
  const payload: unknown = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}
