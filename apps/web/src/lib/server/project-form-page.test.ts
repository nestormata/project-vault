import { describe, expect, it } from 'vitest'
import { testAuthUser } from '$lib/test/page-data.js'
import { projectFormPageLoad } from './project-form-page.js'

describe('projectFormPageLoad', () => {
  it('returns the project id and the viewer org role', () => {
    const user = testAuthUser({ orgRole: 'member' })
    expect(projectFormPageLoad({ params: { projectId: 'p1' }, locals: { user } })).toEqual({
      projectId: 'p1',
      orgRole: 'member',
    })
  })

  it('redirects an anonymous visitor to sign in, as every protected load does', () => {
    expect(() =>
      projectFormPageLoad({ params: { projectId: 'p1' }, locals: { user: null } })
    ).toThrow(expect.objectContaining({ status: 303, location: '/login' }))
  })
})
