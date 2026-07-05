import { createSigner, createVerifier } from 'fast-jwt'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { env } from '../config/env.js'

// Story 7.2 D3 — machine token exchange JWT. epics.md's literal AC text says RS256, but no RS256
// keypair infrastructure exists anywhere in this codebase and architecture.md never actually
// mandates it for machine tokens — see the story's D3 for the full resolution. The story's
// preferred implementation (a second, namespaced `@fastify/jwt` registration) is unavailable:
// the installed `@fastify/jwt@10.1.0` does not support the `namespace` option (confirmed by
// inspecting its shipped type definitions/source — no `namespace` occurrences anywhere).
//
// D3's fallback path calls for a vetted JWT library, not hand-rolled compact-serialization code.
// `fast-jwt` (not `jsonwebtoken`, which the story assumed but which isn't actually a dependency
// anywhere in this lockfile) is `@fastify/jwt`'s own underlying implementation — an existing,
// already-vetted transitive dependency pinned in `pnpm-workspace.yaml`'s overrides — so using it
// directly here satisfies the same intent: a battle-tested library, an explicit single-algorithm
// verify-time allowlist (blocks alg-confusion attacks such as a forged `alg: none` token), and
// constant-time signature comparison performed internally by the library, never hand-rolled.
const ALGORITHM = 'HS256' as const

export type MachineJwtClaims = {
  /** machineUserId */
  sub: string
  orgId: string
  /** projectId the key is scoped to */
  scope: string
  keyId: string
  jti: string
}

export type MachineJwtVerifiedClaims = MachineJwtClaims & { iat: number; exp: number }

export const machineJwtPlugin = fp(async function machineJwtPlugin(
  fastify: FastifyInstance
): Promise<void> {
  // env.ts rejects missing/placeholder/reused production secrets at import time (D3). This
  // fallback only protects concurrent unit tests that temporarily mutate process.env.
  const secret = env.MACHINE_JWT_SECRET || process.env['MACHINE_JWT_SECRET'] || 'h'.repeat(64)

  const sign = createSigner({
    key: secret,
    algorithm: ALGORITHM,
    // D3: exp - iat <= 3600 (<=1h TTL), matching epics.md and architecture.md's agreed value.
    expiresIn: env.MACHINE_JWT_TTL_SECONDS * 1000,
  })
  // Mandatory explicit single-algorithm allowlist — never omit `algorithms`, and never widen it
  // beyond ['HS256']. This is what prevents algorithm-confusion attacks (e.g. a forged token
  // with `alg: none` or `alg: RS256` reusing this HMAC secret as an RSA "public key").
  const verify = createVerifier({ key: secret, algorithms: [ALGORITHM] })

  fastify.decorate('machineJwtSign', async (claims: MachineJwtClaims): Promise<string> =>
    sign(claims)
  )
  fastify.decorate(
    'machineJwtVerify',
    async (token: string): Promise<MachineJwtVerifiedClaims> =>
      verify(token) as unknown as MachineJwtVerifiedClaims
  )
})
