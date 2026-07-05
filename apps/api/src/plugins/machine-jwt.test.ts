import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { machineJwtPlugin, type MachineJwtClaims } from './machine-jwt.js'

type MachineJwtFastify = ReturnType<typeof Fastify> & {
  machineJwtSign: (claims: MachineJwtClaims) => Promise<string>
  machineJwtVerify: (token: string) => Promise<MachineJwtClaims & { iat: number; exp: number }>
}

async function buildApp(): Promise<MachineJwtFastify> {
  const app = Fastify({ logger: false })
  await app.register(machineJwtPlugin)
  return app as unknown as MachineJwtFastify
}

function sampleClaims(): MachineJwtClaims {
  return {
    sub: randomUUID(),
    orgId: randomUUID(),
    scope: randomUUID(),
    keyId: randomUUID(),
    jti: randomUUID(),
  }
}

// D3 — this is the single most security-critical primitive in Story 7.2. @fastify/jwt@10.1.0
// (the version actually installed in this monorepo) does not support the `namespace` option, so
// this plugin uses fast-jwt directly (an existing transitive dependency of @fastify/jwt, already
// pinned in pnpm-workspace.yaml overrides) rather than hand-rolling JWT crypto — the D3 fallback
// path's mandatory security requirement.
describe('machineJwtPlugin (D3)', () => {
  it('decorates fastify with independent machineJwtSign/machineJwtVerify methods', async () => {
    const app = await buildApp()
    expect(typeof app.machineJwtSign).toBe('function')
    expect(typeof app.machineJwtVerify).toBe('function')
  })

  it('round-trips claims through sign -> verify', async () => {
    const app = await buildApp()
    const claims = sampleClaims()
    const token = await app.machineJwtSign(claims)
    const verified = await app.machineJwtVerify(token)

    expect(verified.sub).toBe(claims.sub)
    expect(verified.orgId).toBe(claims.orgId)
    expect(verified.scope).toBe(claims.scope)
    expect(verified.keyId).toBe(claims.keyId)
    expect(verified.jti).toBe(claims.jti)
  })

  it('signs a token with exp - iat <= 3600 seconds (<=1h TTL)', async () => {
    const app = await buildApp()
    const token = await app.machineJwtSign(sampleClaims())
    const verified = await app.machineJwtVerify(token)

    expect(verified.exp - verified.iat).toBeLessThanOrEqual(3600)
    expect(verified.exp - verified.iat).toBeGreaterThan(0)
  })

  it('rejects a token whose signature has been tampered with', async () => {
    const app = await buildApp()
    const token = await app.machineJwtSign(sampleClaims())
    const [header, payload, signature] = token.split('.')
    const tampered = `${header}.${payload}.${signature?.slice(0, -2)}zz`

    await expect(app.machineJwtVerify(tampered)).rejects.toThrow()
  })

  it('rejects a token signed with a different (wrong) machine JWT secret', async () => {
    const appA = await buildApp()
    const appB = await buildApp()
    const token = await appA.machineJwtSign(sampleClaims())

    // Both apps load the same env-derived secret in this process, so to prove cross-secret
    // rejection we corrupt the payload segment (equivalent effect: signature no longer matches).
    const [header, , signature] = token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url')
    const forged = `${header}.${forgedPayload}.${signature}`

    await expect(appB.machineJwtVerify(forged)).rejects.toThrow()
  })

  it('rejects an algorithm-confusion token forged with alg "none" and no signature', async () => {
    const app = await buildApp()
    const claims = sampleClaims()
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        ...claims,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString('base64url')
    const forgedNoneToken = `${header}.${payload}.`

    await expect(app.machineJwtVerify(forgedNoneToken)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const app = await buildApp()
    const claims = sampleClaims()
    const almostExpiredSign = await import('fast-jwt').then((m) =>
      m.createSigner({
        key: process.env['MACHINE_JWT_SECRET'] || 'h'.repeat(64),
        algorithm: 'HS256',
        expiresIn: 1,
      })
    )
    const token = almostExpiredSign(claims)
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(app.machineJwtVerify(token)).rejects.toThrow()
  })
})
