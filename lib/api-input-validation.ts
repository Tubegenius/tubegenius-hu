export const MAX_TOPIC_INPUT_LENGTH = 300

export function topicInputTooLong(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > MAX_TOPIC_INPUT_LENGTH
}

export function topicTooLongResponseMessage(label = 'A téma') {
  return `${label} legfeljebb ${MAX_TOPIC_INPUT_LENGTH} karakter lehet.`
}
