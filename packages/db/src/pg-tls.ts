import {
  resolveTlsMaterial,
  type EnvLike,
  type TlsMaterialSpec,
} from '@project-vault/shared/node-tls'

/**
 * Story 43.16 AC-3 / AC-12: TLS for every Postgres client that can reach the Fly demo DB.
 *
 * The Fly db is a self-run `postgres:16-alpine` app terminating TLS 1.3 with a private CA and
 * requiring a client certificate chained to it (`pg_hba` `clientcert=verify-ca`). postgres.js maps
 * `sslmode=require|prefer|allow` to `rejectUnauthorized: false` and does not read
 * `sslrootcert=<path>`, so the pin must be an explicit `ssl` option object, which wins over the
 * URL's `sslmode`. The URL's `?sslmode=verify-full` documents intent only.
 *
 * All three variables unset ⇒ `{}`: docker-compose, CI and local dev keep plaintext on their
 * private networks, exactly as before.
 */
export const DATABASE_TLS_SPEC: TlsMaterialSpec = {
  certVar: 'DATABASE_TLS_CLIENT_CERT_B64',
  keyVar: 'DATABASE_TLS_CLIENT_KEY_B64',
  caVar: 'DATABASE_TLS_CA_B64',
  role: 'client',
}

export type PgTlsSsl = {
  ca: string
  cert?: string
  key?: string
  minVersion: 'TLSv1.3'
  rejectUnauthorized: true
}

export function pgTlsOptions(
  env: EnvLike = process.env
): { ssl: PgTlsSsl } | Record<string, never> {
  const material = resolveTlsMaterial(env, DATABASE_TLS_SPEC)
  if (material.ca === undefined) return {}
  const ssl: PgTlsSsl = { ca: material.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true }
  if (material.cert !== undefined && material.key !== undefined) {
    ssl.cert = material.cert.pem
    ssl.key = material.key
  }
  return { ssl }
}

// WHATWG URL's TypeError carries the raw input — password included — on its `input` property, so
// it is never rethrown or chained: the replacement names the variable only (NFR-SEC4).
function parseConnectionUrl(connectionString: string): URL {
  try {
    return new URL(connectionString)
  } catch {
    throw new Error('DATABASE_URL is not a parseable URL')
  }
}

/**
 * pg-boss uses node-postgres, which (unlike postgres.js) lets `ssl*` parameters parsed from the
 * connection string OVERRIDE the `ssl` option. With TLS configured, every `ssl*` query parameter
 * is therefore removed so the pinned `ssl` object is the only TLS configuration pg sees.
 */
export function pgBossConnectionOptions(
  connectionString: string,
  env: EnvLike = process.env
): { connectionString: string; ssl?: PgTlsSsl } {
  const tls = pgTlsOptions(env)
  if (!('ssl' in tls)) return { connectionString }
  const url = parseConnectionUrl(connectionString)
  // Collected first: deleting while iterating the live keys() iterator would skip entries.
  const sslParamNames = Array.from(url.searchParams.keys()).filter((name) =>
    name.toLowerCase().startsWith('ssl')
  )
  for (const name of sslParamNames) url.searchParams.delete(name)
  return { connectionString: url.toString(), ssl: tls.ssl }
}
