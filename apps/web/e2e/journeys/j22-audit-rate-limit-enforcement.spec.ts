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
  spawnIsolatedApiProcess,
  stopProcess,
} from '../fixtures/isolated-stack-shared.js'

/**
 * J22 — Story 22.2's own end-to-end proof of per-org audit write-RATE (throughput) limiting.
 * Ships NO web surface (Product Surface Contract: `surface_scope: api`), so — same as J21 for
 * Story 22.1's storage axis — this journey drives the real API directly. Isolated stack because
 * enforcement is gated behind `AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED=true`, off by default, and
 * because the rate cap is SQL-only configuration in the interim (Story 22.3 does not cover a rate
 * surface either — see the story's Product Surface Contract).
 */

const API_PORT = 34831
const DB_NAME = 'project_vault_j22_audit_rate_limit_e2e'
const E2E_PASS_VALUE = 'j22-audit-rate-e2e-Password-1'
const API_BASE = `http://localhost:${API_PORT}`

let apiProcess: ChildProcess

function isolatedDbUrl(): string {
  return superuserDatabaseUrl().replace(/\/[^/]+$/, `/${DB_NAME}`)
}

async function setOrgWriteRatePerMinute(
  orgId: string,
  writeRatePerMinute: number | null
): Promise<void> {
  const sql = postgres(isolatedDbUrl(), { max: 1 })
  try {
    await sql`
      insert into audit_storage_quota_config (org_id, write_rate_per_minute, updated_at)
      values (${orgId}, ${writeRatePerMinute}, now())
      on conflict (org_id) do update set write_rate_per_minute = excluded.write_rate_per_minute, updated_at = now()
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function registerAndLogin(
  request: import('@playwright/test').APIRequestContext,
  opts: { email: string; password: string; orgName: string }
): Promise<{ userId: string; orgId: string }> {
  const register = await request.post(`${API_BASE}/api/v1/auth/register`, {
    data: { email: opts.email, password: opts.password, orgName: opts.orgName },
  })
  expect(register.ok(), await register.text()).toBeTruthy()

  const login = await request.post(`${API_BASE}/api/v1/auth/login`, {
    data: { email: opts.email, password: opts.password },
  })
  expect(login.ok(), await login.text()).toBeTruthy()
  const body = (await login.json()) as { data: { userId: string; orgId: string } }

  const onboarding = await request.post(`${API_BASE}/api/v1/users/me/onboarding`, {
    data: { completed: true },
  })
  expect(onboarding.ok(), await onboarding.text()).toBeTruthy()

  return body.data
}

test.describe.configure({ mode: 'serial' })

test.describe('J22 — Story 22.2: per-org audit write-rate (throughput) limiting', () => {
  test.beforeAll(async () => {
    await createIsolatedDatabase(DB_NAME)
    apiProcess = await spawnIsolatedApiProcess({
      port: API_PORT,
      dbName: DB_NAME,
      webPort: API_PORT, // no web process in this journey; CORS origin is unused
      logLabel: 'api-audit-rate-limit',
      logLevelEnvVar: 'E2E_AUDIT_RATE_LIMIT_LOG_LEVEL',
      extraEnv: {
        AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED: 'true',
        // Storage quota enforcement stays OFF in this journey — the two gates are independent
        // kill switches, and this journey isolates the rate axis specifically.
        AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: 'false',
        AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN: '0',
        AUDIT_ORG_WRITE_RATE_WINDOW_MS: '60000',
      },
    })
    await initIsolatedVault(API_PORT, 'j22-audit-rate-e2e-passphrase')
  })

  test.afterAll(async () => {
    if (apiProcess) await stopProcess(apiProcess)
    await dropIsolatedDatabase(DB_NAME)
  })

  test('golden path: an org well under its rate cap keeps creating audited resources normally', async ({
    request,
  }) => {
    const { orgId } = await registerAndLogin(request, {
      email: uniqueEmail('j22-org-a-owner'),
      password: E2E_PASS_VALUE,
      orgName: `J22 Org A ${randomUUID()}`,
    })
    await setOrgWriteRatePerMinute(orgId, 1000) // comfortable headroom

    const createProject = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'J22 Project', slug: 'j22-project' },
    })
    expect(createProject.ok(), await createProject.text()).toBeTruthy()
  })

  test('rate-exhaustion edge case: an over-cap org is refused with 429 audit_rate_limited + Retry-After, its reads still work, and a sibling org is entirely unaffected', async ({
    request,
  }) => {
    const overEmail = uniqueEmail('j22-org-b-owner')
    const siblingEmail = uniqueEmail('j22-org-c-owner')
    const orgOver = await registerAndLogin(request, {
      email: overEmail,
      password: E2E_PASS_VALUE,
      orgName: `J22 Org B (over rate cap) ${randomUUID()}`,
    })
    const orgSibling = await registerAndLogin(request, {
      email: siblingEmail,
      password: E2E_PASS_VALUE,
      orgName: `J22 Org C (sibling) ${randomUUID()}`,
    })

    // A cap too small to admit even one more non-exempt write this window — registration,
    // login, and onboarding above already consumed the org's window slot(s) via their own
    // audited events (SESSION_CREATED etc. are exempt from refusal but still counted, per AC-6).
    await setOrgWriteRatePerMinute(orgOver.orgId, 1)
    await setOrgWriteRatePerMinute(orgSibling.orgId, 1000)

    const loginAsOver = await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email: overEmail, password: E2E_PASS_VALUE },
    })
    expect(loginAsOver.ok()).toBeTruthy()

    // The org's next non-exempt write must be refused.
    const refused = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Should be refused', slug: 'j22-refused-project' },
    })
    expect(refused.status()).toBe(429)
    const refusedBody = (await refused.json()) as { code: string; message: string }
    expect(refusedBody.code).toBe('audit_rate_limited')
    // AC-7 message hygiene: names no other organization, no instance-wide figure, no numeric cap.
    expect(refusedBody.message.toLowerCase()).not.toContain('instance')
    expect(refusedBody.message).not.toContain(orgSibling.orgId)
    expect(refusedBody.message).not.toMatch(/\d/)

    // AC-7: a Retry-After header, a positive integer number of seconds.
    const retryAfter = refused.headers()['retry-after']
    expect(retryAfter).toBeDefined()
    expect(Number(retryAfter)).toBeGreaterThan(0)

    // The over-cap org's READS still work (only audited mutations are refused).
    const listProjects = await request.get(`${API_BASE}/api/v1/projects`)
    expect(listProjects.ok(), await listProjects.text()).toBeTruthy()

    // The partial-write invariant: the refused create must not have persisted a project row.
    const projectsBody = (await listProjects.json()) as { data: { items: Array<{ slug: string }> } }
    expect(projectsBody.data.items.some((p) => p.slug === 'j22-refused-project')).toBe(false)

    // The sibling org is entirely unaffected — one org's rate refusal must never touch another
    // org's success rate (AC-8/AC-15).
    const loginAsSibling = await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email: siblingEmail, password: E2E_PASS_VALUE },
    })
    expect(loginAsSibling.ok()).toBeTruthy()
    const siblingCreate = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Sibling org unaffected', slug: 'j22-sibling-project' },
    })
    expect(siblingCreate.ok(), await siblingCreate.text()).toBeTruthy()
  })

  test('deadlock-prevention reachability (AC-6): an org at its rate cap can still log in and lower its own audit retention without being refused', async ({
    request,
  }) => {
    const email = uniqueEmail('j22-org-d-owner')
    const { orgId } = await registerAndLogin(request, {
      email,
      password: E2E_PASS_VALUE,
      orgName: `J22 Org D (remediation) ${randomUUID()}`,
    })
    await setOrgWriteRatePerMinute(orgId, 1)

    // Confirm the org really is refused for an ordinary mutation first (registration/onboarding
    // already consumed the single slot).
    const blocked = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Blocked', slug: 'j22-remediation-blocked' },
    })
    expect(blocked.status()).toBe(429)

    // Logging back in (SESSION_CREATED, security_critical) must never be rate-refused — this is
    // the login deadlock the rate axis's exemption reuse exists to close.
    const reLogin = await request.post(`${API_BASE}/api/v1/auth/login`, {
      data: { email, password: E2E_PASS_VALUE },
    })
    expect(reLogin.ok(), await reLogin.text()).toBeTruthy()

    // Lowering retention is a QUOTA_REMEDIATION_EVENT_TYPES write and must succeed anyway, even
    // though the org is still over its rate cap.
    const retention = await request.put(`${API_BASE}/api/v1/org/audit/retention`, {
      data: { retentionDays: 30 },
    })
    expect(retention.ok(), await retention.text()).toBeTruthy()

    // A routine, non-exempt write is still correctly refused — exemption is scoped, not a
    // blanket "org is fine now" reset.
    const stillBlocked = await request.post(`${API_BASE}/api/v1/projects`, {
      data: { name: 'Still blocked', slug: 'j22-still-blocked' },
    })
    expect(stillBlocked.status()).toBe(429)
  })
})
