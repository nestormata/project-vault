// Story 68.7 risk 8: the `getPrimaryNavItems` facade and what PrimaryNav renders come from one data
// source; this pins them equal for the same context (the facade has no action items).
import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/x') } }))

import PrimaryNav from '$lib/components/shell/PrimaryNav.svelte'
import { getPrimaryNavItems } from '$lib/components/shell/nav-model.js'
import { getProjectNavItems } from '$lib/components/shell/project-nav-model.js'
import ProjectNav from '$lib/components/shell/ProjectNav.svelte'

afterEach(cleanup)

describe('facades equal the renderers (Story 68.7 AC-1, risk 8)', () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])('primary: operator=%s panel=%s', (isPlatformOperator, hasUiPanelExtension) => {
    render(PrimaryNav, { props: { isPlatformOperator, hasUiPanelExtension } })
    const rendered = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    const facade = getPrimaryNavItems({ isPlatformOperator, hasUiPanelExtension }).map(
      (i) => i.href
    )
    expect(rendered).toEqual(facade)
  })

  it.each(['owner', 'viewer'])('project: role=%s', (orgRole) => {
    render(ProjectNav, { props: { projectId: 'p1', orgRole } })
    const rendered = screen.getAllByRole('link').map((link) => link.textContent?.trim())
    expect(rendered).toEqual(getProjectNavItems('p1', orgRole).map((item) => item.label))
  })
})
