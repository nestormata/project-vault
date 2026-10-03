// Story 68.7 AC-8: `@project-vault/composition-kit/nav`, CM's authoring API for the nav delta. The
// builders only build plain operation objects (the same shapes PV's nav model applies); nothing
// here validates, limits or refuses an operation (PV validates integrity at compose and in CI).
import { describe, expect, it } from 'vitest'
import { defineNavDelta, hide, insert, move, relabel, remove, reorder, replace } from './index.js'

const label = () => 'Billing'
const PROJECTS = 'primary.projects'
const BILLING = 'cm.billing'
const HEALTH = 'primary.health'

describe('nav builders (Story 68.7 AC-8)', () => {
  it('build the seven operations as plain objects', () => {
    const item = { id: BILLING, label }
    expect(insert({ after: PROJECTS, item })).toEqual({
      op: 'insert',
      after: PROJECTS,
      item,
    })
    expect(remove(HEALTH)).toEqual({ op: 'remove', id: HEALTH })
    expect(hide('settings.index.sso-domains')).toEqual({
      op: 'hide',
      id: 'settings.index.sso-domains',
    })
    expect(relabel('primary.secrets', label)).toEqual({
      op: 'relabel',
      id: 'primary.secrets',
      label,
    })
    expect(relabel('settings.index.users', { description: label })).toEqual({
      op: 'relabel',
      id: 'settings.index.users',
      label: { description: label },
    })
    expect(move(HEALTH, { parent: 'cm.ops' })).toEqual({
      op: 'move',
      id: HEALTH,
      parent: 'cm.ops',
    })
    expect(replace('shell.brand.home', { label })).toEqual({
      op: 'replace',
      id: 'shell.brand.home',
      item: { label },
    })
    expect(reorder('primary', [PROJECTS])).toEqual({
      op: 'reorder',
      parent: 'primary',
      ids: [PROJECTS],
    })
  })

  it('defineNavDelta returns the delta unchanged (typing only, no validation)', () => {
    const delta = { primary: [hide(HEALTH)], 'some.future-surface': [remove('x')] }
    expect(defineNavDelta(delta)).toBe(delta)
  })

  it('types every known surface context for CM callbacks', () => {
    const delta = defineNavDelta({
      project: [
        insert({
          parent: 'project',
          item: {
            id: BILLING,
            label: 'Billing',
            href: (ctx) => `/projects/${ctx.projectId}/billing`,
            when: (ctx) => ctx.orgRole === 'owner',
          },
        }),
      ],
      primary: [
        insert({ parent: 'primary', item: { id: 'cm.x', label: (ctx) => ctx.user.orgRole } }),
      ],
    })
    expect(Object.keys(delta)).toEqual(['project', 'primary'])
  })
})
