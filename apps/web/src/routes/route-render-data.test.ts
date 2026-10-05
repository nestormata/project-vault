// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.5 AC-5: the DATA-RICH twin of route-render-snapshot.test.ts. That oracle renders every
// route file against an EMPTY permissive `data`, so almost no `{#if data.x}` / `{#each}` branch is
// exercised, and two routes throw. This one renders the same 70 route files against a FULL
// permissive `data` (every property is truthy, every list iterates two stable items, every string is
// the unique path of the value that produced it, e.g. `r.users.0.email`) in four variants:
//   full    - every branch that needs data renders, role and gate flags are other truthy values
//   owner   - as full, with the role/gate fields set to an owner who may manage everything
//   denied  - as full, with the role/gate fields set to a viewer who may manage nothing
//   form    - as owner, with a truthy `form` action result (error banners, success notices)
// plus the one route whose own state is browser-only (`projects/preview`) with and without its
// preview project. The snapshot was recorded from `main` @ effe4f8d BEFORE any component was
// extracted and is committed first. After the componentization the same text must come out: never
// regenerate it. The only legitimate change is a deliberate, signed-off markup change in a later
// story. Normalization is `serializeWithoutNoise` (comment nodes and script bodies) plus a
// whitespace collapse; no regex over HTML.

const previewState = vi.hoisted(() => ({ project: null as unknown }))

vi.mock('$lib/state/preview-project.svelte.js', () => ({
  getPreviewProject: () => previewState.project,
}))
vi.mock('$app/state', () => ({
  page: {
    status: 404,
    error: { message: 'Not Found' },
    data: {},
    params: {},
    url: new URL('http://localhost/'),
    route: { id: null },
    form: null,
    state: {},
  },
  navigating: { to: null },
  updated: { current: false },
}))
vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
  onNavigate: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
  preloadData: vi.fn(),
  preloadCode: vi.fn(),
}))
vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => undefined }),
  applyAction: vi.fn(),
  deserialize: vi.fn(),
}))

const routes = import.meta.glob('./**/+{page,layout,error}.svelte', { eager: true }) as Record<
  string,
  { default: never }
>

type Overrides = Record<string, unknown>

/** A full stand-in for any `data` shape. Properties are memoized, so `{#each}` keys stay stable
 * across reads, and each value carries its own path as its string form. */
function full(path: string, overrides: Overrides = {}): unknown {
  const memo = new Map<string | symbol, unknown>()
  const pinned = new Map(Object.entries(overrides))
  let items: unknown[] | null = null
  const target = function () {
    return full(`${path}()`)
  }
  return new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.iterator) {
        return function* () {
          items ??= [full(`${path}.0`), full(`${path}.1`)]
          yield* items
        }
      }
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 1 : path)
      if (key === 'length') return 2
      if (key === 'then') return undefined
      if (key === 'toJSON') return () => path
      if (typeof key === 'string' && pinned.has(key)) {
        return override(`${path}.${key}`, pinned.get(key))
      }
      if (!memo.has(key)) memo.set(key, full(`${path}.${String(key)}`))
      return memo.get(key)
    },
    has: () => true,
  })
}

function isPlainObject(value: unknown): value is Overrides {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  )
}

/** A plain-object override is itself a full value with those properties pinned; everything else
 * (scalars, arrays, null, a ready-made object with a prototype) is returned as given. */
function override(path: string, value: unknown): unknown {
  return isPlainObject(value) ? full(path, value) : value
}

const GATES_OPEN: Overrides = {
  orgRole: 'owner',
  role: 'owner',
  canManage: true,
  canEdit: true,
  isAdmin: true,
  allowed: true,
}
const GATES_SHUT: Overrides = {
  orgRole: 'viewer',
  role: 'viewer',
  canManage: false,
  canEdit: false,
  isAdmin: false,
  allowed: false,
}
const NEGATIVES_OFF: Overrides = {
  errorMessage: null,
  eventsErrorMessage: null,
  maintenanceStatusError: null,
  error: null,
  notFound: false,
  vaultSealed: false,
  mfaRequired: false,
  statusTokenLoadFailed: false,
}
const VARIANTS = {
  full: { data: {}, form: null },
  errors: { data: GATES_OPEN, form: null },
  ready: { data: { ...GATES_OPEN, ...NEGATIVES_OFF }, form: null },
  denied: { data: { ...GATES_SHUT, ...NEGATIVES_OFF }, form: null },
  form: { data: { ...GATES_OPEN, ...NEGATIVES_OFF }, form: 'form' },
} as const

const OWNER_READY: Overrides = { ...GATES_OPEN, ...NEGATIVES_OFF }
const ACTIVE_SHARE = { status: 'active', singleUse: true }

/** Routes whose body switches on a string discriminator or a list length that a truthy value
 * never selects: one extra render per branch, keyed by the route file's path suffix. */
const BRANCHES: Record<string, Record<string, Overrides>> = {
  '/(app)/settings/users/[userId]/erasure/[requestId]/+page.svelte': Object.fromEntries(
    ['not_allowed', 'not_found', 'in_progress', 'pending', 'completed'].map((state) => [
      `state-${state}`,
      { ...OWNER_READY, state },
    ])
  ),
  '/(app)/shares/[token]/+page.svelte': {
    'error-not_found': { ...OWNER_READY, error: 'not_found' },
    'error-session_mismatch': { ...OWNER_READY, error: 'session_mismatch' },
    'metadata-active': { ...OWNER_READY, error: null, metadata: ACTIVE_SHARE },
  },
  '/external-shares/[token]/+page.svelte': {
    'error-not_found': { ...OWNER_READY, error: 'not_found' },
    'error-unavailable': { ...OWNER_READY, error: 'unavailable' },
    'metadata-active': { ...OWNER_READY, error: null, metadata: ACTIVE_SHARE },
  },
  '/status/[token]/+page.svelte': {
    'no-services': { ...OWNER_READY, statusPage: { services: [] } },
    'no-page': { ...OWNER_READY, statusPage: null },
  },
}

// Handcrafted, realistic data for the route whose body the permissive value cannot reach (the
// resource-usage page computes percentages and thresholds from numbers).
const RECONCILED_AT = '2026-10-04T11:00:00.000Z'
const ORG_ROW = {
  orgId: 'org-ok',
  orgName: 'Ok Org',
  bytesUsed: 100_000_000,
  preauthBytesUsed: 0,
  quotaBytes: 1_073_741_824,
  utilizationPct: 9.31,
  refusedWriteCount: 0,
  lastRefusalAt: null,
  lastReconciledAt: RECONCILED_AT,
  writeRatePerMinute: null,
  rateWindowCount: 0,
  rateRefusedCount: 0,
  state: 'ok',
}
const AUDIT_ROWS = [
  ORG_ROW,
  {
    ...ORG_ROW,
    orgId: 'org-unlimited',
    orgName: 'Unlimited Org',
    quotaBytes: null,
    utilizationPct: null,
    state: 'unlimited',
  },
  { ...ORG_ROW, orgId: 'org-stale', orgName: 'Stale Org', lastReconciledAt: null, state: 'stale' },
  {
    ...ORG_ROW,
    orgId: 'org-warn',
    orgName: 'Warn Org',
    utilizationPct: 91,
    state: 'warning',
    writeRatePerMinute: 4,
    rateWindowCount: 9,
    rateRefusedCount: 1,
  },
  { ...ORG_ROW, orgId: 'org-crit', orgName: 'Crit Org', utilizationPct: 97, state: 'critical' },
  {
    ...ORG_ROW,
    orgId: 'org-blocked',
    orgName: 'Blocked Org',
    bytesUsed: 2_000_000_000,
    utilizationPct: 186.3,
    state: 'blocked',
    refusedWriteCount: 3,
    lastRefusalAt: RECONCILED_AT,
  },
]
function usage(overrides: Overrides): Overrides {
  return {
    orgs: { current: 3, limit: 10 },
    usersPerOrg: [{ orgId: 'org-1', current: 5, limit: 50 }],
    secretsPerProject: [{ projectId: 'project-1', orgId: 'org-1', current: 7 }],
    auditLogEntries: { current: 1000, limit: null },
    storageBytes: { current: 900_000, limit: null },
    auditLogStorage: {
      currentBytes: 42_000_000_000,
      limitBytes: 50_000_000_000,
      utilizationPct: 84,
    },
    auditStorageByOrg: AUDIT_ROWS,
    truncated: false,
    allocatedLogicalBytes: 5_000_000_000,
    estimatedPhysicalBytes: 2_000_000_000,
    allocationIncludesUnlimitedOrgs: true,
    observedPhysicalToLogicalRatio: 0.42,
    ...overrides,
  }
}
const HANDCRAFTED: Record<string, Record<string, Overrides>> = {
  '/(app)/platform/settings/resource-usage/+page.svelte': {
    'usage-rows': { ...OWNER_READY, usage: usage({}), warnings: [] },
    'usage-truncated': {
      ...OWNER_READY,
      usage: usage({ truncated: true, auditStorageByOrg: [] }),
      warnings: [],
    },
    'usage-critical': {
      ...OWNER_READY,
      usage: usage({
        orgs: { current: 10, limit: 10 },
        storageBytes: { current: 96, limit: 100 },
        auditLogEntries: { current: 91, limit: 100 },
        auditLogStorage: {
          currentBytes: 49_000_000_000,
          limitBytes: 50_000_000_000,
          utilizationPct: 98,
        },
      }),
      warnings: [],
    },
  },
}

const children = createRawSnippet(() => ({ render: () => '<span data-child></span>' }))

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

function outcome(
  component: never,
  isLayout: boolean,
  variant: (typeof VARIANTS)[keyof typeof VARIANTS]
): string {
  try {
    const { container } = render(component, {
      data: full('r', { origin: 'https://vault.example.com', ...variant.data }),
      form: variant.form === null ? null : full(variant.form),
      ...(isLayout ? { children } : {}),
    } as never)
    return normalize(container)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `THROWS: ${message.split('\n')[0]?.slice(0, 120) ?? ''}`
  } finally {
    cleanup()
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('route render data-rich snapshot (Story 69.5 AC-5)', () => {
  it('covers every one of the 70 route files', () => {
    expect(Object.keys(routes)).toHaveLength(70)
  })

  it('renders every route file with full data exactly as before the componentization', async () => {
    previewState.project = {
      id: 'preview',
      name: 'Preview Project',
      description: 'A temporary preview of the project-centered dashboard.',
      persisted: false,
      dashboard: { suggestedActions: [] },
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'))
    const result: Record<string, string> = {}
    for (const [file, module] of Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))) {
      const isLayout = !file.endsWith('+page.svelte') && !file.endsWith('+error.svelte')
      for (const [name, variant] of Object.entries(VARIANTS)) {
        result[`${file} [${name}]`] = outcome(module.default, isLayout, variant)
      }
      const branches = { ...BRANCHES[file.slice(1)], ...HANDCRAFTED[file.slice(1)] }
      for (const [name, data] of Object.entries(branches)) {
        result[`${file} [${name}]`] = outcome(module.default, isLayout, { data, form: null })
      }
    }
    previewState.project = null
    const preview = routes['./(app)/projects/preview/+page.svelte']
    result['./(app)/projects/preview/+page.svelte [no-project]'] = outcome(
      preview?.default as never,
      false,
      VARIANTS.full
    )
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './route-render-data.snapshot.json'
    )
    const branchCount = [BRANCHES, HANDCRAFTED].reduce(
      (n, table) => n + Object.values(table).reduce((m, entry) => m + Object.keys(entry).length, 0),
      0
    )
    expect(Object.keys(result)).toHaveLength(70 * 5 + 1 + branchCount)
    // Measured: 1.7 s alone and 5.7 s in a full parallel run, so the default 5 s is not enough.
  }, 60_000)
})
