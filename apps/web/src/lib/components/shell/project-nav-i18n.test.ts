// Story 68.7 Q6/AC-4/AC-12: the project tab labels are messages now (the one intended visible
// change of the story: Spanish tabs under `es`; English output unchanged), and the tab bar follows a
// no-reload locale switch without a remount (the Story 28.4 hazard: message functions read no
// Svelte signal, so ProjectNav derives from `page.data`, which SvelteKit's update() replaces).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'
import { reactivePage } from '$lib/test/reactive-page.svelte.js'

vi.mock('$app/state', () => ({ page: reactivePage }))

import ProjectNav from './ProjectNav.svelte'
import { getProjectNavItems } from './project-nav-model.js'

const SPANISH = [
  'Resumen',
  'Secretos',
  'Miembros',
  'Usuarios de máquina',
  'Servicios',
  'Certificados',
  'Dominios',
  'Endpoints',
  'Página de estado',
]

afterEach(async () => {
  cleanup()
  await setLocale('en', { reload: false })
})

describe('project tabs in Spanish (Story 68.7 Q6)', () => {
  it('the facade returns the Spanish labels under es and the same English labels under en', async () => {
    expect(getProjectNavItems('p1', 'owner').map((item) => item.label)).toEqual([
      'Overview',
      'Secrets',
      'Members',
      'Machine Users',
      'Services',
      'Certificates',
      'Domains',
      'Endpoints',
      'Status Page',
    ])
    await setLocale('es', { reload: false })
    expect(getProjectNavItems('p1', 'owner').map((item) => item.label)).toEqual(SPANISH)
  })

  it('ProjectNav switches to Spanish with no remount when page.data is refreshed', async () => {
    reactivePage.url = new URL('http://localhost/projects/p1')
    render(ProjectNav, { props: { projectId: 'p1', orgRole: 'owner' } })
    expect(screen.getByRole('link', { name: 'Overview' })).toBeTruthy()
    await setLocale('es', { reload: false })
    reactivePage.data = { ...reactivePage.data }
    flushSync()
    expect(screen.getAllByRole('link').map((link) => link.textContent?.trim())).toEqual(SPANISH)
    expect(screen.getByRole('link', { name: 'Resumen' }).getAttribute('aria-current')).toBe('page')
  })

  it('no hard-coded English tab label is left in the project nav model or builder', () => {
    for (const file of ['project-nav-model.ts', '../../navigation/surfaces/project.ts']) {
      const code = readFileSync(join(import.meta.dirname, file), 'utf8')
      for (const label of ["'Overview'", "'Members'", "'Machine Users'", "'Status Page'"]) {
        expect(code, file).not.toContain(label)
      }
    }
  })
})
