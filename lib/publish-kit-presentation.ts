export interface PublishKitLinkContext {
  topic: string
  existingTitle?: string
}

export function buildPublishKitHref(href: string, context: PublishKitLinkContext): string {
  const params = new URLSearchParams()
  if (context.topic.trim()) params.set('topic', context.topic.trim())
  if (context.existingTitle?.trim()) params.set('existingTitle', context.existingTitle.trim())
  const query = params.toString()
  return query ? `${href}?${query}` : href
}
