/**
 * Story 9.10 AC-1: the explicit, documented non-`0.0.1` literal reported whenever no
 * `RELEASE_VERSION` is injected at build/run time (local dev, an untagged build, etc.) — fixed
 * and distinguishable so a stray blank `RELEASE_VERSION=""` can never silently look like a real
 * release.
 */
export const DEV_RELEASE_VERSION = 'dev'

export type ReleaseVersion = {
  version: string
  isRelease: boolean
}

/**
 * Story 9.10 AC-1/AC-2: the single source of truth for the runtime's release identity —
 * consumed by `/health`, OpenAPI `info.version`, and (indirectly, via `/health`) the web
 * Version & Upgrade page. Reads only `RELEASE_VERSION` from the environment (baked into the
 * Docker image at build time via `ARG RELEASE_VERSION` / `ENV RELEASE_VERSION` — see
 * apps/api/Dockerfile and .github/workflows/container-publish.yml) — never `.git`, never a
 * network call, and never `package.json`'s permanent `0.0.1` placeholder.
 */
export function getReleaseVersion(
  env: Record<string, string | undefined> = process.env
): ReleaseVersion {
  const raw = env.RELEASE_VERSION?.trim()
  // A value equal to the dev literal is treated exactly like an absent one: it is the documented
  // Dockerfile `ARG RELEASE_VERSION=dev` default, so it reaches the runtime whenever a build did
  // NOT pass the build-arg (a bare `docker build`, a compose `environment:` copy-paste). Reporting
  // it as `isRelease: true` would render "This is a release build." for a build that is, by
  // definition, not one — the exact misrepresentation AC-1 exists to prevent. Compared
  // case-insensitively: a `DEV`/`Dev` spelling (a .env typo, or a CI platform that upper-cases
  // variable values) is the same non-release intent and must not slip through as a release.
  if (raw && raw.toLowerCase() !== DEV_RELEASE_VERSION) {
    return { version: raw, isRelease: true }
  }
  return { version: DEV_RELEASE_VERSION, isRelease: false }
}
