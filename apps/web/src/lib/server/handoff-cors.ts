// Story 30.5 — scoped CORS support for the CM->PV `POST /api/v1/auth/handoff/prepare` proxy
// route only (see Background's "Architecture decision" in
// _bmad-output/implementation-artifacts/30-5-handoff-confirmation-ui.md). This module
// deliberately mirrors `apps/api/src/config/env.ts`'s `CORS_ALLOWED_ORIGINS` parsing
// (comma-separated, trimmed origin set) rather than delegating the CORS decision to `apps/api`
// itself: `apps/api`'s `@fastify/cors` plugin is registered once, globally, in its own process,
// and answering a browser's cross-origin `OPTIONS` preflight for exactly one route requires a
// decision `apps/web` can make locally in a few lines, without an extra internal round-trip for
// every preflight. Both processes read the SAME env var name/value in a real deployment (per the
// Background note: "reusing apps/api's existing env.CORS_ALLOWED_ORIGINS allowlist as the source
// of truth ... do not invent a second, separately-configured allowlist") — this file does not
// introduce a second allowlist, it independently parses the one logical value an operator sets
// for both processes.
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  )
}

export function isOriginAllowed(origin: string | null, allowedOrigins: Set<string>): boolean {
  return origin !== null && allowedOrigins.has(origin)
}

// AC3.11: never a wildcard `*` — this always echoes back the exact matched origin, mirroring
// `apps/api/src/app.ts`'s own CORS discipline (a wildcard is incompatible with
// `Access-Control-Allow-Credentials: true`, and `apps/api`'s own env validation already rejects a
// literal `*` in the configured value).
export function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    // The allowed set is Origin-dependent, so caches (browser or intermediary) must not reuse a
    // response computed for one Origin against a request from a different one.
    Vary: 'Origin',
  }
}
