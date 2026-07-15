export class ExternalServiceTimeoutError extends Error {
  constructor(public readonly service: string, public readonly timeoutMs: number) {
    super(`${service} request timed out after ${timeoutMs} ms`)
    this.name = 'ExternalServiceTimeoutError'
  }
}

export async function fetchExternal(
  service: string,
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const callerSignal = init.signal
  const abortFromCaller = () => controller.abort()
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new ExternalServiceTimeoutError(service, timeoutMs)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function requireOk(response: Response, service: string): Promise<Response> {
  if (response.ok) return response
  const retryAfter = response.headers.get('retry-after')
  const suffix = retryAfter ? `; retry-after=${retryAfter}` : ''
  throw new Error(`${service} HTTP ${response.status}${suffix}`)
}
