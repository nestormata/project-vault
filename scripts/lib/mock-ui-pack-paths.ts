// Story 68.10 AC-3.1: which changed paths run the `Mock UI pack mechanism e2e` job. The filter lives
// INSIDE the workflow (a workflow-level `paths:` filter would leave a REQUIRED check pending forever
// on a PR that skips it), so the job always finishes green and only its heavy steps are conditional.
//
// The list is an INTEGRITY floor, never a narrowing: a change to anything the composed stack runs
// (the apps, every workspace package they depend on, the mock pack, the harness, the Dockerfiles, the
// lockfile, the workflow itself) must run the job. Two failure rules keep it from hiding a regression:
//   - a path under `apps/<dir>` or `packages/<dir>` whose directory is not classified below fails
//     OPEN (the job runs), so a newly added package can never land unfiltered by accident; a unit
//     test enumerates the real directories and requires each to be classified;
//   - an unresolvable base ref or a diff error also fails open (see mock-ui-pack-e2e-filter.ts).

export interface WorkspaceClass {
  runs: boolean
  /** Why a directory is irrelevant (required when `runs` is false). */
  reason?: string
}

/** Every top-level directory of `apps/` and `packages/`, classified. */
export const WORKSPACE_CLASSES: ReadonlyMap<string, WorkspaceClass> = new Map(
  Object.entries<WorkspaceClass>({
    'apps/api': { runs: true },
    'apps/web': { runs: true },
    'packages/agent': { runs: true },
    'packages/composition-kit': { runs: true },
    'packages/crypto': { runs: true },
    'packages/db': { runs: true },
    // lint and type configuration can change a build
    'packages/eslint-config': { runs: true },
    'packages/extension-api': { runs: true },
    'packages/shared': { runs: true },
    'packages/tsconfig': { runs: true },
    'packages/api-contract-tests': {
      runs: false,
      reason: 'a contract-test package neither the api nor the web app depends on',
    },
    'packages/cli': {
      runs: false,
      reason: 'the pvault CLI: not a dependency of the api or the web app',
    },
    'packages/vault-action': {
      runs: false,
      reason: 'the GitHub Action bundle: not a dependency of the api or the web app',
    },
  })
)

/** Files and directories (outside apps/ and packages/) the job depends on. */
const RUN_PREFIXES: readonly string[] = [
  'fixtures/',
  'scripts/lib/web-host/',
  'scripts/web-host-consumer-fixture/',
  'patches/',
]

const RUN_FILES: readonly string[] = [
  // root build inputs of the image builds and the install: a change here can break the stack
  '.dockerignore',
  '.node-version',
  '.npmrc',
  '.nvmrc',
  'turbo.json',
  // helpers the runner and the packer import
  'scripts/lib/release-image.ts',
  'scripts/lib/trusted-executable.ts',
  'scripts/lib/version-triangle.ts',
  '.github/workflows/ci.yml',
  'Dockerfile.ci',
  'Makefile',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/e2e-free-ports.mjs',
  'scripts/e2e-stack.sh',
  'scripts/mock-ui-pack-e2e-filter.ts',
  'scripts/mock-ui-pack-e2e.ts',
  'scripts/pack-web-host.ts',
  'scripts/lib/mock-ui-pack-paths.ts',
]

const RUN_PATTERNS: readonly RegExp[] = [/^docker-compose[^/]*\.ya?ml$/]

export interface Decision {
  run: boolean
  reason: string
}

function workspaceDirOf(path: string): string | null {
  const [root, dir] = path.split('/')
  return (root === 'apps' || root === 'packages') && dir !== undefined ? `${root}/${dir}` : null
}

function fileDecision(path: string): Decision | null {
  const workspace = workspaceDirOf(path)
  if (workspace !== null) {
    const known = WORKSPACE_CLASSES.get(workspace)
    // an unclassified workspace directory fails open
    if (known === undefined) return { run: true, reason: `${workspace} is not classified` }
    return known.runs ? { run: true, reason: `${workspace} is a runtime input` } : null
  }
  if (RUN_FILES.includes(path)) return { run: true, reason: `${path} is part of the job` }
  const prefix = RUN_PREFIXES.find((candidate) => path.startsWith(candidate))
  if (prefix !== undefined) return { run: true, reason: `${prefix}** is part of the job` }
  if (RUN_PATTERNS.some((pattern) => pattern.test(path))) {
    return { run: true, reason: `${path} is a compose file` }
  }
  return null
}

/** Whether a PR with these changed files runs the job. An empty list does not (nothing changed). */
export function decide(files: readonly string[]): Decision {
  for (const path of files) {
    const decision = fileDecision(path)
    if (decision !== null) return { ...decision, reason: `${decision.reason} (${path})` }
  }
  return { run: false, reason: 'skipped: no matching paths' }
}
