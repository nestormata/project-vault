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

  it('strips trailing slash before allowlist lookup', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'GET', url: '/health/' }, reply)
    expect(reply.calls.status).toBeUndefined()
  })

  it('strips query string before allowlist lookup', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'GET', url: '/health?verbose=1' }, reply)
    expect(reply.calls.status).toBeUndefined()
  })

  it('passes /ready/ through the guard layer (the route handler decides 503, not the guard)', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'GET', url: '/ready/' }, reply)
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

  it('blocks auth routes while sealed', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'POST', url: '/api/v1/auth/register' }, reply)
    expect(reply.calls.status).toBe(503)
  })

  it('blocks the same allowlisted path with a different method', async () => {
    const hook = await captureHook()
    const reply = makeReply()
    await hook({ method: 'POST', url: '/health' }, reply)
    expect(reply.calls.status).toBe(503)
  })
})
