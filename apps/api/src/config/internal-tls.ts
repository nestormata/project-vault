import type { X509Certificate } from 'node:crypto'
import type { z } from 'zod/v4'
import { DATABASE_TLS_SPEC } from '@project-vault/db/pg-tls'
import {
  InternalTlsConfigError,
  resolveTlsMaterial,
  type EnvLike,
  type TlsMaterialSpec,
} from '@project-vault/shared/node-tls'

/**
 * Story 43.16 AC-1: opt-in TLS / mTLS on the api listener for the Fly demo's internal web → api
 * hop. All three variables unset ⇒ plain HTTP, byte-for-byte as before (docker-compose, CI, local
 * dev and self-hosted production on a private docker network never set them).
 */
export const API_LISTENER_TLS_SPEC: TlsMaterialSpec = {
  certVar: 'API_TLS_CERT_B64',
  keyVar: 'API_TLS_KEY_B64',
  caVar: 'API_TLS_CLIENT_CA_B64',
  role: 'server',
}

export type ApiListenerTls = {
  mode: 'tls' | 'mtls'
  cert: string
  key: string
  clientCa?: string
  leaf: X509Certificate
}

export function resolveApiListenerTls(env: EnvLike): ApiListenerTls | null {
  const material = resolveTlsMaterial(env, API_LISTENER_TLS_SPEC)
  if (material.cert === undefined || material.key === undefined) return null
  return {
    mode: material.ca === undefined ? 'tls' : 'mtls',
    cert: material.cert.pem,
    key: material.key,
    ...(material.ca === undefined ? {} : { clientCa: material.ca }),
    leaf: material.cert.leaf,
  }
}

/** The DB client leaf the api presents (AC-12), for the AC-9 log line and AC-14 expiry signal. */
export function resolveDatabaseClientLeaf(env: EnvLike): X509Certificate | null {
  return resolveTlsMaterial(env, DATABASE_TLS_SPEC).cert?.leaf ?? null
}

export function isDatabaseTlsPinned(env: EnvLike): boolean {
  return resolveTlsMaterial(env, DATABASE_TLS_SPEC).ca !== undefined
}

/** env.ts `superRefine` hook: reports each misconfigured triple as a Zod issue on the variable at
 * fault. The message names the variable and failure class only, never the value (NFR-SEC4). */
export function validateInternalTlsEnv(env: EnvLike, ctx: z.RefinementCtx): void {
  for (const spec of [API_LISTENER_TLS_SPEC, DATABASE_TLS_SPEC]) {
    try {
      resolveTlsMaterial(env, spec)
    } catch (error) {
      if (!(error instanceof InternalTlsConfigError)) throw error
      ctx.addIssue({ code: 'custom', path: [error.variable], message: error.message })
    }
  }
}
