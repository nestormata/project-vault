import { describe, expect, it } from 'vitest'
import { getPlaceholderSections } from '$lib/components/shell/placeholder-copy.js'

describe('placeholder shell sections', () => {
  it('defines honest placeholders for unavailable primary sections', () => {
    expect(getPlaceholderSections()).toEqual({
      projects: {
        title: 'Projects',
        copy: 'No projects are saved yet. Project persistence arrives in Story 2.1.',
      },
      credentials: {
        title: 'Credentials',
        copy: 'No credentials added yet. Credential storage arrives in Story 2.2.',
      },
      alerts: {
        title: 'Alerts',
        copy: 'No alert sources configured yet. Notifications and alert routing arrive in Epic 3.',
      },
      health: {
        title: 'Health',
        copy: 'No monitored services configured yet. Service and endpoint monitoring arrives in Epic 6.',
      },
      settings: {
        title: 'Settings',
        copy: 'Settings are limited while the MVP shell is being assembled.',
      },
    })
  })

  it('does not include fake counts or green operational claims', () => {
    const content = JSON.stringify(getPlaceholderSections())

    expect(content).not.toContain('All systems healthy')
    expect(content).not.toContain('0 alerts')
    expect(content).not.toContain('green')
  })
})
