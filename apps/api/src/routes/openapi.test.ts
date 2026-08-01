import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

type OpenApiSpec = {
  paths: Record<
    string,
    { get?: { parameters?: Array<{ name: string }>; responses: Record<string, unknown> } }
  >
  components?: { schemas?: Record<string, { additionalProperties?: unknown }> }
}

const OPERATION_PATH = '/api/v1/projects/{projectId}/credentials/{credentialId}/operational-context'

function getOperationalContextOperation(spec: OpenApiSpec) {
  const operation = spec.paths[OPERATION_PATH]?.get
  if (!operation) throw new Error('operational-context operation missing from OpenAPI spec')
  return operation
}

function getSchema(spec: OpenApiSpec, name: string) {
  const schema = spec.components?.schemas?.[name]
  if (!schema) throw new Error(`${name} schema missing from OpenAPI spec`)
  return schema
}

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

  it('publishes the closed v1 operational-context contract and documented errors', async () => {
    const app = await createApp({ logger: false })
    await app.ready()
    const spec = app.swagger() as OpenApiSpec
    const operation = getOperationalContextOperation(spec)
    expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['projectId', 'credentialId', 'cursor', 'limit'])
    )
    expect(operation?.responses).toEqual(
      expect.objectContaining({
        '200': expect.anything(),
        '401': expect.anything(),
        '404': expect.anything(),
        '422': expect.anything(),
        '429': expect.anything(),
      })
    )
    expect(getSchema(spec, 'CredentialOperationalContextV1').additionalProperties).toBe(false)
    expect(getSchema(spec, 'CredentialOperationalContextResponse').additionalProperties).toBe(false)
    await app.close()
  })
})
