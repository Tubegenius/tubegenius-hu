export type PromptLocale = 'hu-HU' | 'en-US'

export interface PromptTemplateDescriptor {
  id: string
  version: string
  locale: PromptLocale
  description: string
}

export interface RenderedPrompt {
  text: string
  templateId: string
  version: string
  locale: PromptLocale
}

const registry = new Map<string, PromptTemplateDescriptor>()

function key(id: string, version: string, locale: PromptLocale) {
  return `${id}@${version}:${locale}`
}

export function definePromptTemplate(descriptor: PromptTemplateDescriptor): PromptTemplateDescriptor {
  if (!descriptor.id.trim() || !/^v\d+(?:\.\d+)*$/.test(descriptor.version)) {
    throw new Error(`Invalid prompt template descriptor: ${descriptor.id}@${descriptor.version}`)
  }
  const registryKey = key(descriptor.id, descriptor.version, descriptor.locale)
  const existing = registry.get(registryKey)
  if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
    throw new Error(`Prompt template collision: ${registryKey}`)
  }
  registry.set(registryKey, Object.freeze({ ...descriptor }))
  return descriptor
}

export function renderPromptTemplate(
  descriptor: PromptTemplateDescriptor,
  render: () => string
): RenderedPrompt {
  definePromptTemplate(descriptor)
  const text = render().trim()
  if (!text) throw new Error(`Prompt template rendered empty: ${descriptor.id}@${descriptor.version}`)
  return { text, templateId: descriptor.id, version: descriptor.version, locale: descriptor.locale }
}

export function listPromptTemplates(): PromptTemplateDescriptor[] {
  return Array.from(registry.values()).map(item => ({ ...item }))
}
