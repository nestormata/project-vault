// Story 72.7 (P3b): below 900 px the project tabs past the first three collapse into a keyboard
// operable "More" menu; at 900 px and up (and before script runs) every tab is inline.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const mockedPage = vi.hoisted(() => ({ url: new URL('http://localhost/projects/x'), data: {} }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import ProjectNav from './ProjectNav.svelte'

type Listener = () => void
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    matches,
    media: '',
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query)
  )
  return {
    set(next: boolean) {
      query.matches = next
      for (const l of listeners) l()
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mockedPage.url = new URL('http://localhost/projects/x')
})

const TABS = [
  'Overview',
  'Secrets',
  'Members',
  'Machine Users',
  'Services',
  'Certificates',
  'Domains',
  'Endpoints',
  'Status Page',
]
const nav = () => screen.getByTestId('project-nav')
const props = { projectId, orgRole: 'member' }

describe('ProjectNav overflow (Story 72.7)', () => {
  it('shows every tab and no More at 900 px and up', async () => {
    stubMatchMedia(false)
    render(ProjectNav, { props })
    await tick()
    for (const label of TABS) expect(screen.getByRole('link', { name: label })).toBeTruthy()
    expect(screen.queryByTestId('project-nav-more')).toBeNull()
  })

  it('shows three tabs and the rest under More below 900 px, in order', async () => {
    stubMatchMedia(true)
    render(ProjectNav, { props })
    await tick()
    const more = screen.getByTestId('project-nav-more')
    const inline = within(nav())
      .getAllByRole('link')
      .filter((a) => !more.contains(a))
      .map((a) => a.textContent?.trim())
    expect(inline).toEqual(TABS.slice(0, 3))
    expect(
      within(more)
        .getAllByRole('link')
        .map((a) => a.textContent?.trim())
    ).toEqual(TABS.slice(3))
  })

  it('follows the viewport when it crosses 900 px', async () => {
    const media = stubMatchMedia(true)
    render(ProjectNav, { props })
    await tick()
    expect(screen.queryByTestId('project-nav-more')).not.toBeNull()
    media.set(false)
    await tick()
    expect(screen.queryByTestId('project-nav-more')).toBeNull()
  })

  it('marks More current when the current tab is inside it', async () => {
    stubMatchMedia(true)
    mockedPage.url = new URL(`http://localhost/projects/${projectId}/domains`)
    render(ProjectNav, { props })
    await tick()
    const summary = screen.getByTestId('project-nav-more').querySelector('summary')
    expect(summary?.getAttribute('data-current')).toBe('true')
    expect(summary?.className).toContain('bg-brand-600')
  })

  it('More opens and closes from the keyboard: Escape returns focus to the trigger', async () => {
    stubMatchMedia(true)
    render(ProjectNav, { props })
    await tick()
    const more = screen.getByTestId('project-nav-more') as HTMLDetailsElement
    const summary = more.querySelector('summary') as HTMLElement
    more.open = true
    more.dispatchEvent(new Event('toggle'))
    await tick()
    const link = within(more).getAllByRole('link')[0] as HTMLElement
    link.focus()
    await fireEvent.keyDown(link, { key: 'Escape' })
    await tick()
    expect(more.open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })

  it('without matchMedia (no script environment) every tab stays inline', async () => {
    vi.stubGlobal('matchMedia', undefined)
    render(ProjectNav, { props })
    await tick()
    expect(screen.queryByTestId('project-nav-more')).toBeNull()
    expect(screen.getByRole('link', { name: 'Status Page' })).toBeTruthy()
  })
})
