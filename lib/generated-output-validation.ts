export interface NextVideoSuggestion { topic: string; reasoning: string }
export function isValidNextVideoSuggestions(value: unknown): value is NextVideoSuggestion[] {
  return Array.isArray(value) && value.length === 10 && value.every(item => !!item && typeof item === 'object' && typeof item.topic === 'string' && item.topic.trim().length > 0 && item.topic.length <= 300 && typeof item.reasoning === 'string' && item.reasoning.trim().length > 0 && item.reasoning.length <= 2000)
}

export interface ScriptAnalysis {
  hook: string
  structure: Array<{ timestamp: string; label: string; content: string; type: string }>
  key_points: string[]
  success_factors: string
}
export function isValidScriptAnalysis(value: unknown): value is ScriptAnalysis {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const nonEmpty = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= max
  return nonEmpty(v.hook, 3000) && nonEmpty(v.success_factors, 5000)
    && Array.isArray(v.key_points) && v.key_points.length > 0 && v.key_points.length <= 30 && v.key_points.every(x => nonEmpty(x, 2000))
    && Array.isArray(v.structure) && v.structure.length > 0 && v.structure.length <= 30 && v.structure.every(x => {
      if (!x || typeof x !== 'object') return false
      const section = x as Record<string, unknown>
      return nonEmpty(section.timestamp, 30) && nonEmpty(section.label, 300) && nonEmpty(section.content, 3000)
        && typeof section.type === 'string' && ['hook', 'intro', 'main', 'cta', 'outro'].includes(section.type)
    })
}
