import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mutable per test: load reads env per request, never cached at module level.
const envMock = vi.hoisted((): { VAULT_HANDOFF_ISSUER?: string } => ({}))

vi.mock('$env/dynamic/private', () => ({ env: envMock }))

import { load } from './+page.server.js'

function makeEvent() {
  return { url: new URL('http://localhost/auth/claim'), cookies: { get: vi.fn() } }
}

describe('/auth/claim +page.server.ts load (Story 73.1)', () => {
  beforeEach(() => {
    Reflect.deleteProperty(envMock, 'VAULT_HANDOFF_ISSUER')
  })

  it('returns no return origin when the web process has no issuer configured', async () => {
    expect(await load(makeEvent() as never)).toMatchObject({ centralizeMeOrigin: null })
  })

  it('returns only the origin of the configured issuer, read per request', async () => {
    envMock.VAULT_HANDOFF_ISSUER = 'https://app.example/router/v1'
    expect(await load(makeEvent() as never)).toMatchObject({
      centralizeMeOrigin: 'https://app.example',
    })
    envMock.VAULT_HANDOFF_ISSUER = 'https://user@evil.example'
    expect(await load(makeEvent() as never)).toMatchObject({ centralizeMeOrigin: null })
  })
})
