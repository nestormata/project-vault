import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/projects'), data: { user: { orgRole: 'owner' } } },
}))

import type { ComponentProps } from 'svelte'
import ProjectCardTags from './ProjectCardTags.svelte'
import { idProblems } from '$lib/test/dom.js'

type Props = ComponentProps<typeof ProjectCardTags>

afterEach(() => cleanup())

const project = {
  id: 'p1',
  name: 'Payments API',
  slug: 'payments-api',
  description: null,
  role: 'owner',
  credentialCount: 0,
  expiringCount: 0,
  alertCount: 0,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  isArchived: false,
} as unknown as Props['project']

function actions(error: string | null): Props['actions'] {
  return {
    tagErrors: { p1: error },
    savingTagsProjectId: null,
    tagInputValue: () => '',
    setTagInput: () => {},
    onSaveTags: () => {},
  } as unknown as Props['actions']
}

// Story 63-5 (DW-612 item 3): a tag error is announced as part of the input's description.
describe('ProjectCardTags error description (Story 63-5)', () => {
  it('adds the error element to aria-describedby while the error shows', () => {
    render(ProjectCardTags, {
      props: { project, actions: actions('Tags must be 32 characters or fewer') },
    })
    const input = document.getElementById('project-tags-p1')
    expect(input?.getAttribute('aria-describedby')).toBe(
      'project-tags-help-p1 project-tags-error-p1'
    )
    expect(document.getElementById('project-tags-error-p1')?.textContent).toContain('32 characters')
    expect(idProblems(document.body)).toEqual([])
  })

  it('references only the help while there is no error', () => {
    render(ProjectCardTags, { props: { project, actions: actions(null) } })
    expect(document.getElementById('project-tags-p1')?.getAttribute('aria-describedby')).toBe(
      'project-tags-help-p1'
    )
  })
})
