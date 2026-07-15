import { describe, expect, it } from 'vitest'
import '@/lib/prompts/catalog'
import { assertPromptTemplateRegistered, definePromptTemplate, listPromptTemplates, renderPromptTemplate } from '@/lib/prompts/template-registry'
import { validateHungarianSeeds } from '@/lib/seed-generator'

describe('versioned prompt templates', () => {
  it('renders text together with auditable identity and locale', () => {
    const template = definePromptTemplate({ id: 'test.prompt', version: 'v1.2', locale: 'hu-HU', description: 'test' })
    expect(renderPromptTemplate(template, () => '  Tartalom  ')).toEqual({ text: 'Tartalom', templateId: 'test.prompt', version: 'v1.2', locale: 'hu-HU' })
    expect(listPromptTemplates()).toContainEqual(template)
  })
  it('rejects unversioned and empty templates', () => {
    expect(() => definePromptTemplate({ id: 'bad', version: 'latest', locale: 'hu-HU', description: 'bad' })).toThrow()
    const valid = definePromptTemplate({ id: 'empty', version: 'v1.0', locale: 'hu-HU', description: 'empty' })
    expect(() => renderPromptTemplate(valid, () => ' ')).toThrow()
  })
  it('registers production prompt identities and rejects unknown versions', () => {
    expect(assertPromptTemplateRegistered('viral_score_explanation', 'v1').id).toBe('viral_score_explanation')
    expect(assertPromptTemplateRegistered('seed_generator', 'v2').version).toBe('v2')
    expect(() => assertPromptTemplateRegistered('viral_score_explanation', 'v999')).toThrow(/Unregistered/)
    expect(listPromptTemplates().length).toBeGreaterThanOrEqual(21)
  })
  it('filters generic and English seeds in the Hungarian market', () => {
    expect(validateHungarianSeeds(['breaking news', 'best camera review', 'fotózás tippek'], 'fotózás')).toEqual([
      `fotózás ${new Date().getFullYear()}`,
      `fotózás ${new Date().getFullYear()}`,
      'fotózás tippek',
    ])
  })
})
