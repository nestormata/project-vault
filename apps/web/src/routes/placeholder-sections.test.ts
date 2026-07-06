import { describe, expect, it } from 'vitest'
import { getPlaceholderSections } from '$lib/components/shell/placeholder-copy.js'

describe('placeholder shell sections', () => {
  it('defines honest placeholders for unavailable primary sections', () => {
    const sections = getPlaceholderSections()

    // Story 6.3: 'health' is removed — /health now renders the real cross-project dashboard
    // (Task 8), so the Epic-6 placeholder copy would be actively misleading if it stayed.
    expect(Object.keys(sections)).toEqual(['projects', 'credentials', 'settings'])
    expect(sections.projects.copy).toContain('Story 2.1')
    expect(sections.credentials.copy).toContain('Choose a project')
    expect(sections.settings.copy).toContain('MVP shell')
    expect('alerts' in sections).toBe(false)
    expect('health' in sections).toBe(false)
  })

  it('does not include fake counts or green operational claims', () => {
    const content = JSON.stringify(getPlaceholderSections())

    expect(content).not.toContain('All systems healthy')
    expect(content).not.toContain('0 alerts')
    expect(content).not.toContain('green')
  })
})
