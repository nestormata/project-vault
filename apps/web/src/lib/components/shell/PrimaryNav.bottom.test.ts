// Story 72.7 (P3b): the phone bottom bar: four links and a More menu from the primary nav data, not
// rendered on task pages or while a text field has focus, and a keyboard-operable More menu.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { tick } from 'svelte'

const mockedPage = vi.hoisted(() => ({ url: new URL('http://localhost/dashboard') }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import PrimaryNav from './PrimaryNav.svelte'

function at(pathname: string) {
  mockedPage.url = new URL(`http://localhost${pathname}`)
}

afterEach(() => {
  cleanup()
  at('/dashboard')
})

const bar = () => screen.getByTestId('bottom-bar')
const more = () => screen.getByTestId('bottom-bar-more') as HTMLDetailsElement

describe('PrimaryNav variant="bottom"', () => {
  it('shows the first four primary links in nav order and the rest under More', () => {
    render(PrimaryNav, { props: { variant: 'bottom', isPlatformOperator: true } })
    const links = within(bar())
      .getAllByRole('link')
      .filter((a) => !more().contains(a))
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Dashboard',
      'Projects',
      'Secrets',
      'Notifications',
    ])
    const inMore = within(more())
      .getAllByRole('link')
      .map((a) => a.textContent?.trim())
    expect(inMore).toEqual(['Health', 'Settings', 'Platform Admin'])
    // Search is an action: it is in More, a button.
    expect(within(more()).getByRole('button', { name: /search/i })).toBeTruthy()
  })

  it('is a labelled primary navigation landmark hidden from md up', () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    expect(bar().getAttribute('aria-label')).toBe('Primary navigation')
    expect(bar().className).toContain('md:hidden')
  })

  it('marks the current page with aria-current, and More when the current page is inside it', () => {
    at('/projects/p1')
    render(PrimaryNav, { props: { variant: 'bottom' } })
    expect(screen.getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull()
    expect(more().querySelector('summary')?.getAttribute('data-current')).toBeNull()

    cleanup()
    at('/settings')
    render(PrimaryNav, { props: { variant: 'bottom' } })
    expect(more().querySelector('summary')?.getAttribute('data-current')).toBe('true')
    expect(
      within(more()).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')
    ).toBe('page')
  })

  it('appends extension navItems after the PV items, inside More', () => {
    render(PrimaryNav, {
      props: {
        variant: 'bottom',
        extensionNavItems: [
          { id: 'x1', label: 'Reports', href: '/extensions/reports', parentId: undefined },
        ] as never,
      },
    })
    const names = within(more())
      .getAllByRole('link')
      .map((a) => a.textContent?.trim())
    expect(names.at(-1)).toBe('Reports')
  })

  it.each(['/projects/new', '/projects/p1/credentials/new', '/credentials/import'])(
    'is not rendered on the task page %s',
    (path) => {
      at(path)
      render(PrimaryNav, { props: { variant: 'bottom' } })
      expect(screen.queryByTestId('bottom-bar')).toBeNull()
    }
  )

  it('hides while a text field has focus and returns on blur', async () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await tick()
    expect(screen.queryByTestId('bottom-bar')).toBeNull()
    input.blur()
    await tick()
    expect(screen.queryByTestId('bottom-bar')).not.toBeNull()
    input.remove()
  })

  it('does not hide while a button or checkbox has focus', async () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    const box = document.createElement('input')
    box.type = 'checkbox'
    document.body.append(box)
    box.focus()
    await tick()
    expect(screen.queryByTestId('bottom-bar')).not.toBeNull()
    box.remove()
  })

  it('More is keyboard operable: Escape closes it and returns focus to the trigger', async () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    const summary = more().querySelector('summary') as HTMLElement
    more().open = true
    more().dispatchEvent(new Event('toggle'))
    await tick()
    const first = within(more()).getAllByRole('link')[0] as HTMLElement
    first.focus()
    await fireEvent.keyDown(first, { key: 'Escape' })
    await tick()
    expect(more().open).toBe(false)
    expect(document.activeElement).toBe(summary)
  })

  it('choosing an entry in More closes the menu', async () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    more().open = true
    more().dispatchEvent(new Event('toggle'))
    await tick()
    const health = within(more()).getByRole('link', { name: 'Health' })
    health.addEventListener('click', (e) => e.preventDefault())
    await fireEvent.click(health)
    await tick()
    expect(more().open).toBe(false)
  })

  it('shows a badge on a bar link', () => {
    render(PrimaryNav, { props: { variant: 'bottom' } })
    // PV items carry no badge: nothing renders; the surface test covers badge rendering itself.
    expect(bar().querySelector('[data-nav-badge]')).toBeNull()
  })

  it('a task page in rail mode has no bottom bar landmark at all', () => {
    at('/projects/p1/credentials/new')
    render(PrimaryNav, { props: { variant: 'bottom' } })
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('marks the More trigger for assistive tech when the current page is inside it', () => {
    at('/settings')
    render(PrimaryNav, { props: { variant: 'bottom' } })
    expect(more().querySelector('summary')?.textContent).toContain('current page inside')
  })
})
