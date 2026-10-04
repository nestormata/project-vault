import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  INJECTION_POINTS,
  type InjectionPointExtras,
  type InjectionPointProps,
} from './injection-points.js'

// Story 69.4 AC-1.5: least-data props. An ungated region receives role and flag fields only; row
// data (members, invitations, audit events) appears only on points PV renders inside its own gate.

const REGION_NAMES = INJECTION_POINTS.filter((point) => point.kind === 'region').map(
  (point) => point.name
)

describe('region point props (Story 69.4 AC-1)', () => {
  it('registers the 17 region points, all 3 segments, none duplicated', () => {
    expect(REGION_NAMES).toHaveLength(17)
    expect(new Set(REGION_NAMES).size).toBe(17)
    for (const name of REGION_NAMES) expect(name.split('.')).toHaveLength(3)
  })

  it('keeps the ungated project members points free of member and invitation data', () => {
    expectTypeOf<InjectionPointProps['project.members.header']>().not.toHaveProperty('members')
    expectTypeOf<InjectionPointProps['project.members.header']>().not.toHaveProperty('invitations')
    expectTypeOf<InjectionPointProps['project.members.notice']>().not.toHaveProperty('members')
    expectTypeOf<InjectionPointProps['project.members.notice']>().not.toHaveProperty('invitations')
    expectTypeOf<InjectionPointProps['project.members.invite']>().not.toHaveProperty('members')
    expectTypeOf<InjectionPointProps['project.members.invite']>().not.toHaveProperty('invitations')
    expectTypeOf<InjectionPointProps['project.members.access']>().toHaveProperty('members')
    expectTypeOf<InjectionPointProps['project.members.invitations']>().toHaveProperty('invitations')
    expect(REGION_NAMES).toContain('project.members.header')
  })

  it('keeps the ungated settings audit points to role and allowed only', () => {
    expectTypeOf<keyof InjectionPointExtras<'settings.audit.header'>>().toEqualTypeOf<
      'orgRole' | 'allowed'
    >()
    expectTypeOf<keyof InjectionPointExtras<'settings.audit.notice'>>().toEqualTypeOf<
      'orgRole' | 'allowed'
    >()
    expectTypeOf<keyof InjectionPointExtras<'settings.audit.navigation'>>().toEqualTypeOf<
      'orgRole' | 'allowed'
    >()
    expectTypeOf<InjectionPointProps['settings.audit.results']>().toHaveProperty('events')
    expect(REGION_NAMES).toContain('settings.audit.navigation')
  })

  it('requires the page entity props and rejects a foreign entity', () => {
    expectTypeOf<InjectionPointExtras<'project.members.access'>>().toHaveProperty('members')
    expectTypeOf<InjectionPointExtras<'project.members.access'>>().not.toHaveProperty('project')
    expectTypeOf<InjectionPointExtras<'project.members.access'>['members']>().not.toBeNullable()
    expectTypeOf<InjectionPointExtras<'settings.notifications.routing'>['routing']>().toExtend<
      readonly unknown[]
    >()
  })
})
