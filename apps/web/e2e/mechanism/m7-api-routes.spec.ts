import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  anonymousApi,
  apiContextFor,
  countAuditEvents,
  createProject,
  seedOrgOwner,
} from './fixtures.js'

// Story 68.10 AC-1 / AC-7 / AC-10, M7 (API routes) against the REAL API and database behind the
// composed web: only what needs real sessions, tenants, RLS, audit and rate limits (the exhaustive
// in-process matrix is fixtures/mock-api-routes-extension's, and the module pack's own checks are
// apps/api/src/__tests__/mock-ui-pack-module.integration.test.ts). Routes outside /api/v1 are
// reachable only on the API port, so the checks use it directly (same run, same report).
const DOCUMENTS = '/api/v1/cm/documents'
const DOCUMENT_EVENT = 'cm.document.created'
const FAULT_TIMEOUT_SECONDS = '60'
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

test.describe('M7 API routes', () => {
  test('works: add reads only the caller org rows, wrap extends the PV project, HEAD and replace answer behind the session', async ({
    context,
    browser,
    playwright,
  }) => {
    await seedOrgOwner(context, 'm7-a')
    const projectA = await createProject(context, `m7-a-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'm7-b')
      const projectB = await createProject(contextB, `m7-b-${randomUUID().slice(0, 8)}`)
      const a = await apiContextFor(playwright, context)
      const documents = await a.get(DOCUMENTS)
      const visible = ((await documents.json()) as { data: { visibleProjectIds: string[] } }).data
        .visibleProjectIds
      expect(visible).toContain(projectA)
      expect(visible).not.toContain(projectB)
      const wrapped = await a.get(`/api/v1/projects/${projectA}`)
      const data = ((await wrapped.json()) as { data: { id: string; cmTiles: string[] } }).data
      expect(data.id).toBe(projectA)
      expect(data.cmTiles).toEqual([`mock-ui-pack:m7-tile-${projectA}`])
      const head = await a.head(`/api/v1/projects/${projectA}`)
      expect(head.status()).toBe(200)
      expect(head.headers()['x-cm-head']).toBe('explicit')
      expect((await head.body()).length).toBe(0)
      const replaced = await a.get('/api/v1/users/me')
      expect((await replaced.json()) as unknown).toEqual({
        data: { cm: 'mock-ui-pack:m7-replaced' },
      })
      await a.dispose()
    } finally {
      await contextB.close()
    }
  })

  test('works: a UI read of the wrapped project through the composed web shows the pack field', async ({
    page,
    context,
  }) => {
    await seedOrgOwner(context, 'm7-ui')
    const projectId = await createProject(context, `m7-ui-${randomUUID().slice(0, 8)}`)
    await page.goto(`/api/v1/projects/${projectId}`)
    await expect(page.locator('body')).toContainText(`mock-ui-pack:m7-tile-${projectId}`)
  })

  test('fails (denied): anonymous callers get 401 and an org B session gets 404 for org A data through the wrapped route', async ({
    context,
    browser,
    playwright,
  }) => {
    await seedOrgOwner(context, 'm7-deny-a')
    const projectA = await createProject(context, `m7-deny-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'm7-deny-b')
      const anonymous = await anonymousApi(playwright)
      for (const path of [DOCUMENTS, `/api/v1/projects/${projectA}`, '/api/v1/users/me']) {
        expect((await anonymous.get(path)).status(), path).toBe(401)
      }
      const b = await apiContextFor(playwright, contextB)
      const cross = await b.get(`/api/v1/projects/${projectA}`)
      expect(cross.status()).toBe(404)
      const missing = await b.get(`/api/v1/projects/${randomUUID()}`)
      expect(await cross.text()).toBe(await missing.text())
      await anonymous.dispose()
      await b.dispose()
    } finally {
      await contextB.close()
    }
  })

  test('works: the pack gate denies its write capability, the public webhook needs no session, replaceSecurity is honoured both ways', async ({
    context,
    playwright,
  }) => {
    await seedOrgOwner(context, 'm7-gate')
    const api = await apiContextFor(playwright, context)
    const denied = await api.get('/api/v1/cm/gated')
    expect(denied.status()).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'capability_denied',
      capability: 'cm.documents.write',
    })
    expect((await api.get('/api/v1/cm/own-capability')).status()).toBe(200)
    const anonymous = await anonymousApi(playwright)
    const webhook = await anonymous.post('/cm/webhooks/acme', { data: {} })
    expect((await webhook.json()) as unknown).toEqual({ received: 'acme' })
    // loosened on purpose: reachable anonymously (recorded, never refused)
    const loosened = await anonymous.post('/api/v1/auth/cli-login', { data: {} })
    expect(loosened.status()).toBe(200)
    // tightened on purpose: an anonymous caller is still refused
    expect((await anonymous.get('/api/v1/capabilities')).status()).toBe(401)
    await api.dispose()
    await anonymous.dispose()
  })

  test('works: the mutating add route writes exactly one audit row per call and none when denied', async ({
    context,
    playwright,
  }) => {
    const user = await seedOrgOwner(context, 'm7-audit')
    const api = await apiContextFor(playwright, context)
    const anonymous = await anonymousApi(playwright)
    const before = await countAuditEvents(user.orgId, DOCUMENT_EVENT)
    expect((await anonymous.post(DOCUMENTS, { data: { title: 'x' } })).status()).toBe(401)
    expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before)
    const created = await api.post(DOCUMENTS, { data: { title: 'm7-doc' } })
    expect(created.status()).toBe(200)
    expect(await countAuditEvents(user.orgId, DOCUMENT_EVENT)).toBe(before + 1)
    await api.dispose()
    await anonymous.dispose()
  })

  test('fails (rejected): the pack low bucket answers 429 on the 4th call while another route in the window is unaffected', async ({
    context,
    playwright,
  }) => {
    await seedOrgOwner(context, 'm7-limit')
    const api = await apiContextFor(playwright, context)
    const statuses: number[] = []
    for (let call = 0; call < 4; call += 1) {
      statuses.push((await api.get('/api/v1/cm/limited')).status())
    }
    expect(statuses).toEqual([200, 200, 200, 429])
    expect((await api.get(DOCUMENTS)).status()).toBe(200)
    await api.dispose()
  })

  test('works: ten concurrent calls from two orgs each see only their own rows and the audit count equals the mutations', async ({
    context,
    browser,
    playwright,
  }) => {
    const userA = await seedOrgOwner(context, 'm7-conc-a')
    const projectA = await createProject(context, `m7-conc-a-${randomUUID().slice(0, 8)}`)
    const contextB = await browser.newContext({ baseURL: process.env['E2E_BASE_URL'] })
    try {
      await seedOrgOwner(contextB, 'm7-conc-b')
      const projectB = await createProject(contextB, `m7-conc-b-${randomUUID().slice(0, 8)}`)
      const a = await apiContextFor(playwright, context)
      const b = await apiContextFor(playwright, contextB)
      const before = await countAuditEvents(userA.orgId, DOCUMENT_EVENT)
      const calls = Array.from({ length: 10 }, async () => {
        const [fromA, fromB, posted] = await Promise.all([
          a.get(DOCUMENTS),
          b.get(DOCUMENTS),
          a.post(DOCUMENTS, { data: { title: 'conc' } }),
        ])
        return { fromA, fromB, posted }
      })
      for (const { fromA, fromB, posted } of await Promise.all(calls)) {
        const idsA = ((await fromA.json()) as { data: { visibleProjectIds: string[] } }).data
        const idsB = ((await fromB.json()) as { data: { visibleProjectIds: string[] } }).data
        expect(idsA.visibleProjectIds).toContain(projectA)
        expect(idsA.visibleProjectIds).not.toContain(projectB)
        expect(idsB.visibleProjectIds).toContain(projectB)
        expect(idsB.visibleProjectIds).not.toContain(projectA)
        expect(posted.status()).toBe(200)
      }
      expect(await countAuditEvents(userA.orgId, DOCUMENT_EVENT)).toBe(before + 10)
      await a.dispose()
      await b.dispose()
    } finally {
      await contextB.close()
    }
  })

  test('fails (rejected): the fail-closed boot makes a REQUIRED pack with a missing wrap target exit non-zero with a bounded startup.failed line', async () => {
    const run = spawnSync('/usr/bin/bash', [join(REPO_ROOT, 'scripts/e2e-stack.sh'), 'fault'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, E2E_FAULT_TIMEOUT_SECONDS: FAULT_TIMEOUT_SECONDS },
      timeout: 180_000,
    })
    const output = `${run.stdout}\n${run.stderr}`
    // the script exits 0 exactly when the api-faulty container EXITED NON-ZERO (the proof holds) and 1
    // when it unexpectedly stayed up or exited 0
    expect(run.status, output.slice(-3000)).toBe(0)
    expect(output).toContain('fault exit=')
    expect(output).not.toContain('fault exit=0')
    expect(output).toContain('startup.failed')
    expect(output).toContain('extension_api_route_drift')
    // never a connection string or credentials, and it never reported healthy
    expect(output).not.toMatch(/postgres(ql)?:\/\//)
    expect(output).not.toContain('"status":"ok"')
  })
})
