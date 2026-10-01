// Story 68.1 (Q2): typed fixtures for unit tests, so `src/**/*.test.ts` type-checks under the
// enforced svelte-check gate without casts.
//
// - A page component's `data` prop is its route's full `PageData`, which includes everything the
//   parent layouts returned. Every page under `(app)` therefore needs the `(app)` layout fields;
//   `appLayoutData()` supplies them with neutral defaults so each test only spells out the fields
//   its own page loader returns.
// - SvelteKit types a `load` declared as `PageServerLoad` as returning `void | data`;
//   `expectLoaded()` asserts data came back (a real check, not a cast) before a test reads it.
import type { AuthUser } from '$lib/api/auth.js'
import type { LayoutData as AppLayoutData } from '../../routes/(app)/$types.js'
import type { LayoutData as ProjectLayoutData } from '../../routes/(app)/projects/[projectId]/$types.js'
import { SAMPLE_PROJECT_ID, sampleProject } from './fixtures.js'

export type { AppLayoutData, ProjectLayoutData }

/** A signed-in org owner with MFA settled; override any field per test. */
export function testAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'user-1',
    orgId: 'org-1',
    orgName: 'Acme Inc',
    sessionId: 'session-1',
    orgRole: 'owner',
    isPlatformOperator: false,
    mfaEnrolled: false,
    mfaEnrolledAt: null,
    remainingRecoveryCodesCount: null,
    mfaStatus: {
      enrollmentRequired: false,
      gracePeriodActive: false,
      gracePeriodExpiresAt: null,
      gracePeriodDaysRemaining: null,
      bannerMessage: null,
    },
    ...overrides,
  }
}

/** The `(app)/+layout.server.ts` data every page under `(app)` receives, with neutral defaults. */
export function appLayoutData(overrides: Partial<AppLayoutData> = {}): AppLayoutData {
  return {
    user: testAuthUser(),
    onboardingCompleted: true,
    projects: [],
    importRouteLive: false,
    unreadCount: 0,
    hasUiPanelExtension: false,
    extensionNavItems: [],
    appliedTheme: null,
    orphanedNotice: false,
    orphanedThemeName: null,
    themeCss: '',
    ...overrides,
  }
}

/** The layout data every page under `projects/[projectId]` receives (`(app)` + project layout). */
export function projectLayoutData(overrides: Partial<ProjectLayoutData> = {}): ProjectLayoutData {
  return {
    ...appLayoutData(),
    projectId: SAMPLE_PROJECT_ID,
    orgRole: 'owner',
    project: sampleProject(),
    ...overrides,
  }
}

/** A page under `(app)`: the `(app)` layout data merged with the page's own `load` fields. */
export function appPageData<P extends object>(page: P): AppLayoutData & P {
  return { ...appLayoutData(), ...page }
}

/** The `(app)` page data a platform/org-gated page receives when the viewer is not allowed. */
export function deniedPageData(): AppLayoutData & { allowed: false } {
  const denied: { allowed: false } = { allowed: false }
  return appPageData(denied)
}

/** The `void` member of a `load()` result type (written as a return type, where `void` is valid). */
type VoidResult = ReturnType<() => void>

/** Runtime check: a `load()` that returned nothing yields `undefined`. */
function isLoaded<R>(result: R): result is Exclude<R, VoidResult> {
  return result !== undefined
}

/** Returns a `load()` result after asserting it is not `void`. */
export function expectLoaded<R>(result: R): Exclude<R, VoidResult> {
  if (!isLoaded(result)) throw new Error('load() returned no data')
  return result
}

/**
 * A named form action, failing the test when it is not defined. `Actions` is a string-keyed record,
 * so `actions.name` is possibly undefined under `noUncheckedIndexedAccess`.
 */
export function expectAction<A extends Record<string, unknown>, K extends keyof A & string>(
  actions: A,
  name: K
): NonNullable<A[K]> {
  // Own properties only: an inherited `Object.prototype` member is never a form action.
  if (!Object.hasOwn(actions, name)) throw new Error(`no "${name}" action`)
  const { [name]: action } = actions
  if (action === undefined || action === null) throw new Error(`no "${name}" action`)
  return action
}
