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
  return typeof v.hook === 'string' && v.hook.length <= 3000 && typeof v.success_factors === 'string' && v.success_factors.length <= 5000 && Array.isArray(v.key_points) && v.key_points.length <= 30 && v.key_points.every(x => typeof x === 'string' && x.length <= 2000) && Array.isArray(v.structure) && v.structure.length <= 100 && v.structure.every(x => !!x && typeof x === 'object' && ['timestamp', 'label', 'content', 'type'].every(k => typeof (x as Record<string, unknown>)[k] === 'string'))
}
