import { describe, expect, it } from 'vitest'
import { buildPublishKitHref } from '@/lib/publish-kit-presentation'

describe('Publish Kit presentation', () => {
  it('keeps an empty stage link clean', () => {
    expect(buildPublishKitHref('/dashboard/title-studio', { topic: '   ' })).toBe('/dashboard/title-studio')
  })

  it('carries the trimmed topic between frontend stages', () => {
    const href = buildPublishKitHref('/dashboard/thumbnail-studio', { topic: '  nézői figyelem  ' })
    expect(href).toBe('/dashboard/thumbnail-studio?topic=n%C3%A9z%C5%91i+figyelem')
  })

  it('carries an accepted title into the upload stage', () => {
    const href = buildPublishKitHref('/dashboard/seo-optimizer', { topic: 'Téma', existingTitle: '  Elfogadott cím  ' })
    expect(href).toContain('topic=T%C3%A9ma')
    expect(href).toContain('existingTitle=Elfogadott+c%C3%ADm')
  })
})
