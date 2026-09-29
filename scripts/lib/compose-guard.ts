// Story 60.7 AC3.3: scripts/check-compose-config.test.ts needs the Docker Compose CLI. Outside CI
// a missing CLI is a SKIP (a laptop or cloud sandbox without Docker); in CI it is a FAILURE, so
// the suite can never be "wired but silently skipped" there. GitHub sets CI=true on every job.
export type ComposeGuard = 'run' | 'skip' | 'fail'

export const COMPOSE_REQUIRED_IN_CI_MESSAGE =
  '[check-compose-config] Docker Compose is required in CI (CI=true) but was not found'

export function resolveComposeGuard(input: {
  ci: string | undefined
  hasCompose: boolean
}): ComposeGuard {
  if (input.hasCompose) return 'run'
  return input.ci === 'true' ? 'fail' : 'skip'
}
