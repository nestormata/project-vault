import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { organizations } from '@project-vault/db/schema'
import { createApp } from '../../app.js'

const TOKEN = 'test-only-service-provisioning-token-32-bytes-min'
const TOKEN_HEADER = 'x-service-provisioning-token'
const ROUTE_URL = '/api/v1/service/organizations'

type InjectResponse = Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>>
type SuccessBody = { data: { organizationId: string; userId: string; externalIdentityId: string } }
type ErrorBody = { code: string; message: string }

function successBody(res: InjectResponse): SuccessBody {
  return res.json() as SuccessBody
}

function errorBody(res: InjectResponse): ErrorBody {
  return res.json() as ErrorBody
}

describe('POST /api/v1/service/organizations', () => {
  // env.ts's `env` singleton is computed once per test-file module load; mutate it directly
  // (a plain, non-frozen object) rather than process.env, which env.ts would only re-read on a
  // fresh module evaluation that already happened before this test file's beforeEach runs.
  let originalToken: string | undefined

  beforeEach(async () => {
    const { env } = await import('../../config/env.js')
    originalToken = (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] as
      string | undefined
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = TOKEN
  })

  afterEach(async () => {
    const { env } = await import('../../config/env.js')
    ;(env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN'] = originalToken
  })

  async function freshApp() {
    return createApp({ logger: false })
  }

  it('AC-1/AC-3: atomically creates an org, user, and external identity, returning 201', async () => {
    const app = await freshApp()
    const requestId = randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `Test Org ${requestId}`,
        workosUserId: `user_${requestId}`,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    expect(body.data.organizationId).toBeTruthy()
    expect(body.data.userId).toBeTruthy()
    expect(body.data.externalIdentityId).toBeTruthy()
    await app.close()
  })

  it('Story 30.2: an optional centralizemeOrganizationId is persisted on the organization row', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const centralizemeOrganizationId = `org_synthetic_${requestId}`

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `CM Org ${requestId}`,
        workosUserId: `user_${requestId}`,
        centralizemeOrganizationId,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    const [row] = await getDb()
      .select({ centralizemeOrganizationId: organizations.centralizemeOrganizationId })
      .from(organizations)
      .where(eq(organizations.id, body.data.organizationId))
    expect(row?.centralizemeOrganizationId).toBe(centralizemeOrganizationId)
    await app.close()
  })

  it('Story 30.2: omitting centralizemeOrganizationId (CM caller not yet updated) leaves it null', async () => {
    const app = await freshApp()
    const requestId = randomUUID()

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId,
        organizationName: `No CM Org ${requestId}`,
        workosUserId: `user_${requestId}`,
      },
    })

    expect(res.statusCode).toBe(201)
    const body = successBody(res)
    const [row] = await getDb()
      .select({ centralizemeOrganizationId: organizations.centralizemeOrganizationId })
      .from(organizations)
      .where(eq(organizations.id, body.data.organizationId))
    expect(row?.centralizemeOrganizationId).toBeNull()
    await app.close()
  })

  it('AC-4: a repeated call with the same requestId returns the SAME result, not a duplicate', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const payload = {
      requestId,
      organizationName: `Replay Org ${requestId}`,
      workosUserId: `user_${requestId}`,
    }

    const first = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload,
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(successBody(second).data).toEqual(successBody(first).data)
    await app.close()
  })

  it('AC-4: genuine concurrency — two simultaneous requests with the same requestId create exactly one org', async () => {
    const app = await freshApp()
    const requestId = randomUUID()
    const payload = {
      requestId,
      organizationName: `Concurrent Org ${requestId}`,
      workosUserId: `user_${requestId}`,
    }

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: ROUTE_URL,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: ROUTE_URL,
        headers: { [TOKEN_HEADER]: TOKEN },
        payload,
      }),
    ])

    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(successBody(a).data).toEqual(successBody(b).data)
    await app.close()
  })

  it('AC-5: a different requestId with the same name/subject creates a genuinely new org', async () => {
    const app = await freshApp()
    const suffix = randomUUID()
    const first = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: `Dup Name Org ${suffix}`,
        workosUserId: `user_${suffix}`,
      },
    })
    const second = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: `Dup Name Org ${suffix}`,
        workosUserId: `user_${suffix}`,
      },
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(successBody(second).data.organizationId).not.toBe(successBody(first).data.organizationId)
    await app.close()
  })

  it('AC-7: missing token is rejected with 403', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      payload: {
        requestId: randomUUID(),
        organizationName: 'No Token Org',
        workosUserId: 'user_no_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-7: wrong token is rejected with the SAME 403 body as a missing token', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: 'definitely-wrong-token-value-000000' },
      payload: {
        requestId: randomUUID(),
        organizationName: 'Wrong Token Org',
        workosUserId: 'user_wrong_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-8: unset SERVICE_PROVISIONING_TOKEN makes the route unreachable (403) even with the right-shaped header', async () => {
    const { env } = await import('../../config/env.js')
    delete (env as unknown as Record<string, unknown>)['SERVICE_PROVISIONING_TOKEN']
    const app = await createApp({ logger: false })

    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: {
        requestId: randomUUID(),
        organizationName: 'Unset Token Org',
        workosUserId: 'user_unset_token',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errorBody(res).code).toBe('service_provisioning_forbidden')
    await app.close()
  })

  it('AC-6: missing requestId is a 422 validation error, no partial write', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { organizationName: 'No Request Id Org', workosUserId: 'user_x' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC-6: empty organizationName is a 422 validation error', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), organizationName: '', workosUserId: 'user_x' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })

  it('AC-6: empty workosUserId is a 422 validation error', async () => {
    const app = await freshApp()
    const res = await app.inject({
      method: 'POST',
      url: ROUTE_URL,
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: { requestId: randomUUID(), organizationName: 'Some Org', workosUserId: '' },
    })
    expect(res.statusCode).toBe(422)
    await app.close()
  })
})
