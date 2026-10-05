import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ProjectOverview } from '@project-vault/shared'
import type { CredentialDetail } from '@project-vault/shared'
import type { OrgRole } from '$lib/credentials/permissions.js'
import {
  INJECTION_POINTS,
  type CredentialPointProps,
  type InjectionPointExtras,
  type InjectionPointProps,
  type StandardPointProps,
} from './injection-points.js'

// Story 69.2 AC-3: the props contract of every point of the credential detail page. A later edit
// cannot silently drop a field: the type assertions below fail `svelte-check` / `tsc`, and the runtime
// assertions pin the registry rows the guards and the web-host manifest are generated from.

const HOST = '/(app)/projects/[projectId]/credentials/[credentialId]#page'

const REGIONS = [
  'credential.detail.actions',
  'credential.detail.dependencies',
  'credential.detail.footer',
  'credential.detail.lifecycle',
  'credential.detail.metadata',
  'credential.detail.not-found',
  'credential.detail.nudges',
  'credential.detail.rotation',
  'credential.detail.shares',
  'credential.detail.summary',
  'credential.detail.value',
  'credential.detail.vault-sealed',
  'credential.detail.versions',
] as const

const STANDARD = [
  'credential.detail.after',
  'credential.detail.before',
  'credential.detail.header.actions',
] as const

describe('CredentialPointProps (Story 69.2 AC-3)', () => {
  it('carries the route, the credential, the project and the caller roles', () => {
    expectTypeOf<CredentialPointProps>().toEqualTypeOf<{
      routeId: string
      params: Record<string, string>
      credential: CredentialDetail | null
      project: ProjectOverview | null
      projectId: string
      credentialId: string
      orgRole: OrgRole
      projectRole: ProjectOverview['role'] | null
    }>()
    expectTypeOf<CredentialPointProps>().toExtend<StandardPointProps>()
    // A fill written against the older `{ credential }` shape keeps compiling: every field is additive.
    expectTypeOf<Pick<CredentialPointProps, 'credential'>>().toEqualTypeOf<{
      credential: CredentialDetail | null
    }>()
  })

  it('has no field that could carry a one-shot or revealed value', () => {
    const keys: (keyof CredentialPointProps)[] = [
      'routeId',
      'params',
      'credential',
      'project',
      'projectId',
      'credentialId',
      'orgRole',
      'projectRole',
    ]
    expectTypeOf<keyof CredentialPointProps>().toEqualTypeOf<(typeof keys)[number]>()
    expect(keys).not.toContain('origin')
  })

  it('is the props type of every standard and region point of the page', () => {
    for (const name of [...STANDARD, ...REGIONS]) {
      expectTypeOf<InjectionPointProps[typeof name]>().toEqualTypeOf<CredentialPointProps>()
      expect(INJECTION_POINTS.find((point) => point.name === name)?.propsType).toBe(
        'CredentialPointProps'
      )
    }
  })

  it('leaves a point caller the extras beyond the standard route id and params', () => {
    expectTypeOf<InjectionPointExtras<'credential.detail.shares'>>().toEqualTypeOf<
      Omit<CredentialPointProps, 'routeId' | 'params'>
    >()
  })
})

describe('credential detail registry rows (Story 69.2 AC-1)', () => {
  it('registers the three standard points as standard', () => {
    for (const name of STANDARD) {
      expect(INJECTION_POINTS.find((point) => point.name === name)?.kind).toBe('standard')
    }
  })

  it('registers every region as a region hosted by the credential detail page', () => {
    const rows = INJECTION_POINTS.filter((point) =>
      point.name.startsWith('credential.detail.')
    ).filter((point) => point.kind === 'region')
    expect(rows.map((row) => row.name).sort()).toEqual([...REGIONS])
    for (const row of rows) expect(row.hostRoutes).toEqual([HOST])
  })

  it('names no point twice', () => {
    const names = INJECTION_POINTS.map((point) => point.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
