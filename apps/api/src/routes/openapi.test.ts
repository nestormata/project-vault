import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

// NODE_ENV is 'test' throughout this suite (setup-env.ts / the ambient vitest env), which is one
// of docs-gating.ts's allowlisted values — see docs-gating.test.ts for the full gating matrix
// (production-default-off, ENABLE_API_DOCS=true override, etc.), unit-tested in isolation so this
// file doesn't need to boot multiple full Fastify apps under different env vars (which collides
// with prom-client's process-global metrics registry across repeated app boots in one process).
describe('GET /api/v1/openapi.json and GET /api/v1/docs (D5, AC-6/AC-7)', () => {
  it('serves the live spec at /api/v1/openapi.json, matching app.swagger() exactly (AC-6)', async () => {
    const app = await createApp({ logger: false })
    await app.ready()
    const direct = app.swagger()

    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(direct)

    await app.close()
  })

  it('serves Swagger UI at /api/v1/docs (AC-7)', async () => {
    const app = await createApp({ logger: false })
    const res = await app.inject({ method: 'GET', url: '/api/v1/docs' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    await app.close()
  })
})
