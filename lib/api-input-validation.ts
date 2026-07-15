export const MAX_TOPIC_INPUT_LENGTH = 300

export function topicInputTooLong(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > MAX_TOPIC_INPUT_LENGTH
}

export function topicTooLongResponseMessage(label = 'A téma') {
  return `${label} legfeljebb ${MAX_TOPIC_INPUT_LENGTH} karakter lehet.`
}

export function isScoreOrNull(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

export function isJsonWithinLimit(value: unknown, maxBytes = 20_000): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes
  } catch {
    return false
  }
}

export function isOptionalTextWithinLimit(value: unknown, maxLength: number): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= maxLength)
}
