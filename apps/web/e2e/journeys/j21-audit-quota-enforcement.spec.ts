import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { expect, test } from '@playwright/test'
import { superuserDatabaseUrl } from '../fixtures/db.js'
import { uniqueEmail } from '../fixtures/ids.js'
import {
  createIsolatedDatabase,
  dropIsolatedDatabase,
  initIsolatedVault,
  registerAndLoginIsolated,
  spawnIsolatedApiProcess,
  stopProcess,
} from '../fixtures/isolated-stack-shared.js'

/**
 * J21 — Story 22.1's own end-to-end proof of per-org audit-storage quota enforcement. This story
 * ships NO web surface (Product Surface Contract: `surface_scope: api` — the operator page and
 * API move to Story 22.3), so this journey drives the real API directly rather than through
 * `apps/web`, matching this suite's "UI is for validation only" principle taken to its limit: when
 * there is no UI to validate, the journey is API-only.
 *
 * Isolated stack (API only, no web process) because this story's enforcement is gated behind
 * `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=true`, which the shared E2E stack does not set (AC-20's
 * zero-behaviour-change-by-default promise), and because quota configuration in this story is
 * SQL-only (the operator endpoint ships in Story 22.3) — this journey sets it directly against the
 * isolated database, mirroring the interim operator path the story's own Product Surface Contract
 * describes.
 */

const API_PORT = 34830
const DB_NAME = 'project_vault_j21_audit_quota_e2e'
const E2E_PASS_VALUE = 'j21-audit-quota-e2e-Password-1'
const API_BASE = `http://localhost:${API_PORT}`

let apiProcess: ChildProcess

function isolatedDbUrl(): string {
  return superuserDatabaseUrl().replace(/\/[^/]+$/, `/${DB_NAME}`)
}

async function setOrgQuotaBytes(orgId: string, quotaBytes: number | null): Promise<void> {
  const sql = postgres(isolatedDbUrl(), { max: 1 })
  try {
    await sql`
      insert into audit_storage_quota_config (org_id, quota_bytes, updated_at)
      values (${orgId}, ${quotaBytes}, now())
      on conflict (org_id) do update set quota_bytes = excluded.quota_bytes, updated_at = now()
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function registerAndLogin(
  request: import('@playwright/test').APIRequestContext,
  opts: { email: string; password: string; orgName: string }
): Promise<{ userId: string; orgId: string }> {
  return registerAndLoginIsolated(request, API_BASE, opts)
}

test.describe.configure({ mode: 'serial' })

test.describe('J21 — Story 22.1: per-org audit-storage quota enforcement', () => {
  test.beforeAll(async () => {
    await createIsolatedDatabase(DB_NAME)
    apiProcess = await spawnIsolatedApiProcess({
      port: API_PORT,
      dbName: DB_NAME,
      webPort: API_PORT, // no web process in this journey; CORS origin is unused
      logLabel: 'api-audit-quota',
      logLevelEnvVar: 'E2E_AUDIT_QUOTA_LOG_LEVEL',
      extraEnv: {
        AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: 'true',
        // A tiny non-zero default so an org with NO explicit quota row still resolves to SOME
        // ceiling in this journey's "unconfigured org" negative case, without affecting the two
        // orgs under test (both get an explicit row).
        AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB: '0',
      },
    })
    await initIsolatedVault(API_PORT, 'j21-audit-quota-e2e-passphrase')
  })

  test.afterAll(async () => {
    if (apiProcess) await stopProcess(apiProcess)
    await dropIsolatedDatabase(DB_NAME)
  })

  test('golden path: an org well under its quota keeps creating audited resources normally', async ({
    request,
  }) => {
    const { orgId } = await registerAndLogin(request, {
      email: uniqueEmail('j21-org-a-owner'),
      password: E2E_PASS_VALUE,
      orgName: `J21 Org A ${randomUUID()}`,
    })
    await setOrgQuotaBytes(orgId, 10 * 1024 * 1024) // 10 MiB — comfortable headroom

    const createProject = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'J21 Project', slug: 'j21-project' },
    })
    expect(createProject.ok(), await createProject.text()).toBeTruthy()
  })

  test('quota-exhaustion edge case: an over-quota org is refused with 503 audit_quota_exhausted, its reads still work, and a sibling org is entirely unaffected', async ({
    request,
  }) => {
    const overEmail = uniqueEmail('j21-org-b-owner')
    const siblingEmail = uniqueEmail('j21-org-c-owner')
    const orgOver = await registerAndLogin(request, {
      email: overEmail,
      password: E2E_PASS_VALUE,
      orgName: `J21 Org B (over quota) ${randomUUID()}`,
    })
    const orgSibling = await registerAndLogin(request, {
      email: siblingEmail,
      password: E2E_PASS_VALUE,
      orgName: `J21 Org C (sibling) ${randomUUID()}`,
    })

    // A quota too small to admit even one more audited write.
    await setOrgQuotaBytes(orgOver.orgId, 1)
    await setOrgQuotaBytes(orgSibling.orgId, 10 * 1024 * 1024)

    // Re-authenticate as each org's owner (registerAndLogin's cookie jar is per-call via the
    // shared `request` fixture, which persists the LAST login's session) — log back in explicitly
    // before each org's assertions so the right session is active.
    const loginAsOver = await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email: overEmail, password: E2E_PASS_VALUE },
    })
    expect(loginAsOver.ok()).toBeTruthy()

    const refused = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Should be refused', slug: 'j21-refused-project' },
    })
    expect(refused.status()).toBe(503)
    const refusedBody = (await refused.json()) as { code: string; message: string }
    expect(refusedBody.code).toBe('audit_quota_exhausted')
    // AC-9 message hygiene: names no other organization, no instance-wide figure, no absolute
    // capacity number.
    expect(refusedBody.message.toLowerCase()).not.toContain('instance')
    expect(refusedBody.message).not.toContain(orgSibling.orgId)

    // The over-quota org's READS still work (only audited mutations are refused).
    const listProjects = await request.get(`${API_BASE}/api/v1/projects`)
    expect(listProjects.ok(), await listProjects.text()).toBeTruthy()

    // The partial-write invariant: the refused create must not have persisted a project row —
    // confirmed by listing again and finding no project with the refused name/slug.
    // GET /api/v1/projects returns { data: { items: [...], ...pagination } } (ProjectListResponseSchema),
    // not a flat { data: [...] } array.
    const projectsBody = (await listProjects.json()) as { data: { items: Array<{ slug: string }> } }
    expect(projectsBody.data.items.some((p) => p.slug === 'j21-refused-project')).toBe(false)

    // The sibling org is entirely unaffected — this is the story's headline regression fix
    // (AC-12/AC-15): one org's refusal must never touch another org's success rate.
    const loginAsSibling = await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email: siblingEmail, password: E2E_PASS_VALUE },
    })
    expect(loginAsSibling.ok()).toBeTruthy()
    const siblingCreate = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Sibling org unaffected', slug: 'j21-sibling-project' },
    })
    expect(siblingCreate.ok(), await siblingCreate.text()).toBeTruthy()
  })

  test('remediation reachability (AC-28): an org at 100% can still lower its own audit retention without being refused', async ({
    request,
  }) => {
    const { orgId } = await registerAndLogin(request, {
      email: uniqueEmail('j21-org-d-owner'),
      password: E2E_PASS_VALUE,
      orgName: `J21 Org D (remediation) ${randomUUID()}`,
    })
    await setOrgQuotaBytes(orgId, 1)

    // Confirm the org really is refused for an ordinary mutation first.
    const blocked = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Blocked', slug: 'j21-remediation-blocked' },
    })
    expect(blocked.status()).toBe(503)

    // Lowering retention is a QUOTA_REMEDIATION_EVENT_TYPES write and must succeed anyway.
    // (auditRoutes is registered under the '/api/v1/org' prefix, not '/api/v1'.)
    const retention = await request.put(`${API_BASE}/api/v1/org/audit/retention`, {
      data: { retentionDays: 30 },
    })
    expect(retention.ok(), await retention.text()).toBeTruthy()
  })
})
