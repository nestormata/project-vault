import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cookieHeader,
  configureAuthIntegrationEnv,
  createProjectViaApi,
  initVaultForTest,
  type CookieJar,
} from './helpers/auth-test-helpers.js'
import { API_ROUTES_FIXTURE_PACKAGE, importApiRoutesFixture } from './helpers/api-routes-fixture.js'
import { createMembershipTestHelpers } from './helpers/membership-test-helpers.js'

/**
 * Story 69.18 — the project-role gate on extension routes, through the real loader, `createApp()`,
 * sessions, roles and RLS, with the mock api-routes fixture in every shape the gate distinguishes
 * (see the fixture's `project-role` scenario). The fixture handlers only name themselves, so a 200
 * means the gate let the caller through and a 403 means it did not.
 */
process.env['VAULT_EXTENSIONS_PACKAGE'] = API_ROUTES_FIXTURE_PACKAGE
configureAuthIntegrationEnv()

const { createApp } = await import('../app.js')
const { initVault } = await import('../modules/vault/key-service.js')
const { resetVaultForTest } = await import('./helpers/vault-test-cleanup.js')
const { __resetExtensionStateForTests } = await import('../extensions/loader.js')
const fixture = await importApiRoutesFixture()

type TestApp = Awaited<ReturnType<typeof createApp>>
type Caller = { cookies: CookieJar }
type Status = 200 | 403

const DENIED = {
  code: 'insufficient_project_role',
  message: 'Your role in this project does not permit this action',
}

const { registerOwner, addUserToOrg, addProjectMember } = createMembershipTestHelpers({
  emailPrefix: 'ext-project-role',
  orgNamePrefix: 'Ext Project Role',
})

/** One request shape per route of the fixture scenario. */
const ROUTES = {
  addDefault: { method: 'POST', path: (id: string) => `/api/v1/cm/projects/${id}/notes` },
  addViewer: { method: 'POST', path: (id: string) => `/api/v1/cm/projects/${id}/notes/narrow` },
  addAdmin: { method: 'POST', path: (id: string) => `/api/v1/cm/projects/${id}/notes/admin` },
  addUnscoped: {
    method: 'POST',
    path: (id: string) => `/api/v1/cm/projects/${id}/notes/unscoped`,
  },
  addRead: { method: 'GET', path: (id: string) => `/api/v1/cm/projects/${id}/notes` },
  wrapNoReplaceSecurity: { method: 'PUT', path: (id: string) => `/api/v1/projects/${id}/tags` },
  replaceNoReplaceSecurity: {
    method: 'POST',
    path: (id: string) => `/api/v1/projects/${id}/services`,
  },
  replaceSecurityDefault: {
    method: 'POST',
    path: (id: string) => `/api/v1/projects/${id}/archive`,
  },
  replaceSecurityViewer: {
    method: 'POST',
    path: (id: string) => `/api/v1/projects/${id}/unarchive`,
  },
} as const
type RouteName = keyof typeof ROUTES

function bootScenario(scenario: 'project-role' | 'project-role-legacy', label: string) {
  const state: {
    app: TestApp
    projectId: string
    callers: Record<string, Caller>
  } = {} as never

  beforeAll(async () => {
    delete process.env['RELEASE_VERSION']
    await resetVaultForTest()
    await initVaultForTest(initVault, `ext-project-role-${label}-passphrase`)
    __resetExtensionStateForTests()
    fixture.setApiRoutesScenario(scenario)
    fixture.resetObserved()
    state.app = await createApp({ logger: false, vaultGuardEnabled: true })

    const owner = await registerOwner(state.app, `${label}-owner`)
    state.projectId = await createProjectViaApi(state.app, owner.cookies, `ext-role-${label}`)
    const member = async (name: string, orgRole: string, projectRole?: string) => {
      const user = await addUserToOrg(state.app, owner.orgId, `${label}-${name}`, { orgRole })
      if (projectRole)
        await addProjectMember(owner.orgId, state.projectId, user.userId, projectRole)
      return user
    }
    const foreignOwner = await registerOwner(state.app, `${label}-foreign`)
    state.callers = {
      orgOwner: owner,
      projectViewer: await member('viewer', 'member', 'viewer'),
      projectMember: await member('member', 'member', 'member'),
      projectOwner: await member('powner', 'member', 'owner'),
      orgAdminWithViewerRow: await member('admin', 'admin', 'viewer'),
      orgMemberNoRow: await member('norow', 'member'),
      foreignOrgOwner: foreignOwner,
      foreignOrgViewer: await addUserToOrg(state.app, foreignOwner.orgId, `${label}-fviewer`, {
        orgRole: 'viewer',
      }),
    }
  }, 120_000)

  afterAll(async () => {
    await state.app.close()
    __resetExtensionStateForTests()
    fixture.setApiRoutesScenario('default')
    await resetVaultForTest()
  })

  async function call(callerName: string, route: RouteName, projectId = state.projectId) {
    const caller = state.callers[callerName]
    if (!caller) throw new Error(`unknown caller ${callerName}`)
    const { method, path } = ROUTES[route]
    const response = await state.app.inject({
      method,
      url: path(projectId),
      headers: { cookie: cookieHeader(caller.cookies) },
      ...(method === 'GET' ? {} : { payload: {} }),
    })
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() }
  }

  async function statuses(route: RouteName, callerNames: string[]) {
    const out: Record<string, number> = {}
    for (const name of callerNames) out[name] = (await call(name, route)).status
    return out
  }

  return { state, call, statuses }
}

const SAME_ORG = [
  'orgOwner',
  'orgAdminWithViewerRow',
  'projectOwner',
  'projectMember',
  'projectViewer',
  'orgMemberNoRow',
]

function expectMatrix(actual: Record<string, number>, expected: Record<string, Status>) {
  expect(actual).toEqual(expected)
}

const MEMBER_FLOOR: Record<string, Status> = {
  orgOwner: 200,
  orgAdminWithViewerRow: 200,
  projectOwner: 200,
  projectMember: 200,
  projectViewer: 403,
  orgMemberNoRow: 200,
}
const OPEN: Record<string, Status> = Object.fromEntries(SAME_ORG.map((name) => [name, 200]))

describe('Story 69.18 — extension project writes on the current contract', () => {
  const { state, call, statuses } = bootScenario('project-role', 'current')

  it('an add defaults to project role member', async () => {
    expectMatrix(await statuses('addDefault', SAME_ORG), MEMBER_FLOOR)
    expect((await call('projectViewer', 'addDefault')).body).toEqual(DENIED)
  })

  it('an unscoped add (no PV transaction) gets the same gate', async () => {
    expectMatrix(await statuses('addUnscoped', SAME_ORG), MEMBER_FLOOR)
  })

  it("an explicit 'viewer' keeps the action open to a project viewer", async () => {
    expectMatrix(await statuses('addViewer', SAME_ORG), OPEN)
  })

  it("an explicit 'admin' refuses project members and owners below admin", async () => {
    expectMatrix(await statuses('addAdmin', SAME_ORG), {
      orgOwner: 200,
      orgAdminWithViewerRow: 200,
      projectOwner: 200,
      projectMember: 403,
      projectViewer: 403,
      orgMemberNoRow: 403,
    })
  })

  it('a read under :projectId stays ungated', async () => {
    expectMatrix(await statuses('addRead', SAME_ORG), OPEN)
  })

  it.each(['wrapNoReplaceSecurity', 'replaceNoReplaceSecurity'] as const)(
    "%s keeps PV's gate",
    async (route) => {
      expectMatrix(await statuses(route, SAME_ORG), MEMBER_FLOOR)
    }
  )

  it('replaceSecurity that omits the role cannot drop the gate', async () => {
    expectMatrix(await statuses('replaceSecurityDefault', SAME_ORG), MEMBER_FLOOR)
  })

  it("replaceSecurity with an explicit 'viewer' opens it", async () => {
    expectMatrix(await statuses('replaceSecurityViewer', SAME_ORG), OPEN)
  })

  it('a foreign org gets the same answer as for a project that does not exist (no oracle)', async () => {
    const missing = randomUUID()
    for (const caller of ['foreignOrgOwner', 'foreignOrgViewer']) {
      for (const route of ['addDefault', 'addUnscoped', 'replaceSecurityDefault'] as const) {
        const foreign = await call(caller, route)
        const absent = await call(caller, route, missing)
        expect({ caller, route, status: foreign.status }).toEqual({
          caller,
          route,
          status: absent.status,
        })
      }
    }
    expect((await call('foreignOrgViewer', 'addDefault')).status).toBe(403)
    expect(state.projectId).not.toBe(missing)
  })

  it('a denied caller never reaches the extension handler', async () => {
    fixture.resetObserved()
    await call('projectViewer', 'addDefault')
    await call('projectViewer', 'addUnscoped')
    await call('projectViewer', 'replaceSecurityDefault')
    expect([...fixture.observed.calls.keys()]).toEqual([])
  })
})

describe('Story 69.18 — a legacy (3.36.0) manifest keeps the behaviour it was written against', () => {
  const { statuses } = bootScenario('project-role-legacy', 'legacy')

  it('adds and replaceSecurity overrides are not defaulted', async () => {
    for (const route of ['addDefault', 'addUnscoped', 'replaceSecurityDefault'] as const) {
      expectMatrix(await statuses(route, SAME_ORG), OPEN)
    }
  })

  it("a declared role is still honoured, and a wrap without replaceSecurity keeps PV's gate", async () => {
    expectMatrix(await statuses('addAdmin', ['projectMember', 'orgAdminWithViewerRow']), {
      projectMember: 403,
      orgAdminWithViewerRow: 200,
    })
    expectMatrix(await statuses('wrapNoReplaceSecurity', SAME_ORG), MEMBER_FLOOR)
  })
})
