import { describe, it, expect, vi } from 'vitest'
import { vaultGuardPlugin } from './vault-guard.js'

vi.mock('../modules/vault/key-service.js', () => ({
  getVaultStatus: vi.fn(() => 'sealed'),
}))

type Hook = (req: { method: string; url: string }, reply: ReturnType<typeof makeReply>) => unknown

function makeReply() {
  const calls: { status?: number; body?: unknown } = {}
  return {
    status(code: number) {
      calls.status = code
      return {
        send(body: unknown) {
          calls.body = body
          return calls
        },
      }
    },
    calls,
  }
}

async function captureHook(): Promise<Hook> {
  let hook: Hook | undefined
  const fakeApp = {
    addHook: (_name: string, fn: Hook) => {
      hook = fn
    },
  }
  await vaultGuardPlugin(fakeApp as never)
  if (!hook) throw new Error('hook not registered')
  return hook
}

describe('vaultGuardPlugin', () => {
  it('blocks non-allowlisted routes while sealed', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'GET', url: '/metrics' }, reply)
    expect(reply.calls.status).toBe(503)
    expect(reply.calls.body).toEqual({ status: 'sealed', message: 'Vault not initialized' })
  })

  it('allows GET /health through regardless of seal state', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    const result = await hook({ method: 'GET', url: '/health' }, reply)
    expect(result).toBeUndefined()
    expect(reply.calls.status).toBeUndefined()
  })

  it.each([
    { name: 'strips trailing slash before allowlist lookup', method: 'GET', url: '/health/' },
    {
      name: 'strips query string before allowlist lookup',
      method: 'GET',
      url: '/health?verbose=1',
    },
    {
      name: 'passes /ready/ through the guard layer (the route handler decides 503, not the guard)',
      method: 'GET',
      url: '/ready/',
    },
    {
      name: 'allows public auth routes while sealed',
      method: 'POST',
      url: '/api/v1/auth/register',
    },
    { name: 'allows GET /api/v1/docs through while sealed', method: 'GET', url: '/api/v1/docs' },
    {
      name: 'allows Swagger UI static sub-paths under /api/v1/docs/ through while sealed',
      method: 'GET',
      url: '/api/v1/docs/static/swagger-ui.css',
    },
  ])('$name', async ({ method, url }) => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method, url }, reply)
    expect(reply.calls.status).toBeUndefined()
  })

  it('allows POST /api/v1/vault/init and /unseal', async () => {
    const hook = await captureHook()
    const reply1 = makeReply()
    await hook({ method: 'POST', url: '/api/v1/vault/init' }, reply1)
    expect(reply1.calls.status).toBeUndefined()

    const reply2 = makeReply()
    await hook({ method: 'POST', url: '/api/v1/vault/unseal' }, reply2)
    expect(reply2.calls.status).toBeUndefined()
  })

  it.each([
    {
      name: 'blocks protected auth routes while sealed',
      method: 'GET',
      url: '/api/v1/auth/sessions',
    },
    { name: 'blocks MFA recovery while sealed', method: 'POST', url: '/api/v1/auth/mfa/recover' },
    {
      name: 'blocks the same allowlisted path with a different method',
      method: 'POST',
      url: '/health',
    },
  ])('$name', async ({ method, url }) => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method, url }, reply)
    expect(reply.calls.status).toBe(503)
  })

  // Story 9.3 AC-16: an operator diagnosing a sealed vault needs to consult the API docs
  // without first unsealing — same rationale as /health/ready/metrics.
  it('allows GET /api/v1/openapi.json through while sealed', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    const result = await hook({ method: 'GET', url: '/api/v1/openapi.json' }, reply)
    expect(result).toBeUndefined()
    expect(reply.calls.status).toBeUndefined()
  })
})
