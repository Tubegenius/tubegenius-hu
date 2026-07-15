import { describe, expect, it } from 'vitest'
import { definePromptTemplate, listPromptTemplates, renderPromptTemplate } from '@/lib/prompts/template-registry'

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
})
