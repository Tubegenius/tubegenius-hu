import { definePromptTemplate } from './template-registry'

export const PROMPT_TEMPLATES = {
  titleStudio: definePromptTemplate({ id: 'title-studio.generate', version: 'v1.0', locale: 'hu-HU', description: 'Öt eltérő magyar címváltozat és AI-értékelés.' }),
  keywordCluster: definePromptTemplate({ id: 'keyword-research.cluster', version: 'v1.0', locale: 'hu-HU', description: 'Long-tail kulcsszóklaszter valós keresési jelekből.' }),
  contentGap: definePromptTemplate({ id: 'content-gap.discover', version: 'v1.0', locale: 'hu-HU', description: 'Tartalmi rések valós YouTube- és Google-jelek összevetésével.' }),
} as const
