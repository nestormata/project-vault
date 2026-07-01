import { describe, expect, it } from 'vitest'
import { getPlaceholderSections } from '$lib/components/shell/placeholder-copy.js'

describe('placeholder shell sections', () => {
  it('defines honest placeholders for unavailable primary sections', () => {
    const sections = getPlaceholderSections()

    expect(Object.keys(sections)).toEqual(['projects', 'credentials', 'health', 'settings'])
    expect(sections.projects.copy).toContain('Story 2.1')
    expect(sections.credentials.copy).toContain('Choose a project')
    expect(sections.health.copy).toContain('Epic 6')
    expect(sections.settings.copy).toContain('MVP shell')
    expect('alerts' in sections).toBe(false)
  })

  it('does not include fake counts or green operational claims', () => {
    const content = JSON.stringify(getPlaceholderSections())

    expect(content).not.toContain('All systems healthy')
    expect(content).not.toContain('0 alerts')
    expect(content).not.toContain('green')
  })
})
