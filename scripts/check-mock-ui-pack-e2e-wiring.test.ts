// Story 68.10 AC-3: the `Mock UI pack mechanism e2e` job is wired the way a REQUIRED check must be
// (pure text in, assertions out, like check-web-guard-wiring.test.ts), the path filter behaves, and
// the mechanism specs cannot pass vacuously (Playwright reports skipped tests as green).
//
// Making the check REQUIRED is a repo-admin action (branch protection has no required status checks
// today) and is a hand-off, not something this test can do: until it is done the docs say "required
// in intent, enforced by this wiring test, not yet by branch protection".
import { describe, expect, it } from 'vitest'
import { makeRecipe } from './lib/ci-wiring.js'
import { WORKSPACE_CLASSES, decide } from './lib/mock-ui-pack-paths.js'
import { filterFor } from './mock-ui-pack-e2e-filter.js'

const WORKFLOW: Record<string, string> = import.meta.glob('../.github/workflows/ci.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
})
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal.
const MAKEFILE: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const SPECS: Record<string, string> = import.meta.glob('../apps/web/e2e/mechanism/*.spec.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const CONFIG: Record<string, string> = import.meta.glob(
  '../apps/web/playwright.mechanism.config.ts',
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
)

// Static repository text read through Vite (no dynamic fs path anywhere in this test). Keys keep the
// pattern's relative spelling (`../apps/web/e2e/tsconfig.json`).
const REPO_TEXT = new Map(
  Object.entries(
    import.meta.glob(
      [
        '../apps/web/e2e/tsconfig.json',
        '../fixtures/mock-ui-pack/docker/web.Dockerfile',
        '../fixtures/mock-ui-pack/docker/.dockerignore',
        '../docker-compose.mock-ui-pack.yml',
        './e2e-stack.sh',
      ],
      { query: '?raw', import: 'default', eager: true }
    )
  ).map(([key, text]) => [key, String(text)] as const)
)
/** The workspace members (every `apps/<dir>` and `packages/<dir>` is a package with a manifest). */
const WORKSPACE_MANIFESTS: Record<string, string> = import.meta.glob(
  '../{apps,packages}/*/package.json',
  { query: '?raw', import: 'default', eager: true }
)

const workflow = Object.values(WORKFLOW)[0] ?? ''
const JOB_ID = 'mock-ui-pack-e2e'
const RUN_COMMAND = 'pnpm tsx scripts/mock-ui-pack-e2e.ts'

/** The text of one top-level job of ci.yml (from its key to the next job key). */
function jobText(id: string): string {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  if (start === -1) return ''
  const rest = workflow.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe('the mock UI pack mechanism job is wired as a required check (Story 68.10 AC-3)', () => {
  const job = jobText(JOB_ID)

  it('exists with its stable name, runs the pinned command and cannot be skipped by configuration', () => {
    expect(job).not.toBe('')
    expect(job).toContain('name: Mock UI pack mechanism e2e')
    expect(job).toContain(RUN_COMMAND)
    expect(job).toMatch(/timeout-minutes: \d+/)
    expect(job).not.toMatch(/continue-on-error/)
    expect(job).not.toMatch(/^\s*if:\s*false\s*$/m)
    // not commented out: every line that names the command is a live `run` line
    for (const line of job.split('\n').filter((entry) => entry.includes(RUN_COMMAND))) {
      expect(line.trim().startsWith('#'), line).toBe(false)
    }
  })

  it('filters INSIDE the workflow (never a workflow-level paths filter) and fails open', () => {
    expect(workflow).not.toMatch(/^on:[\s\S]*?\n\s+paths:/m)
    expect(job).toContain('pnpm tsx scripts/mock-ui-pack-e2e-filter.ts')
    expect(job).toContain('fetch-depth: 0')
    expect(job).toContain("steps.filter.outputs.run == 'true'")
    // push and dispatch always run it
    expect(job).toMatch(/event_name.*pull_request|pull_request.*event_name/s)
  })

  it('tears down by project prefix with always(), and uploads only the report and the log on failure', () => {
    expect(job).toMatch(/if: always\(\)/)
    expect(job).toContain('pv-mock-ui-pack-')
    expect(job).toMatch(/if: failure\(\)/)
    expect(job).toContain('playwright-mechanism-output/html')
    expect(job).not.toContain('playwright-mechanism-output/artifacts')
  })

  it('has a Makefile target that runs the same command', () => {
    const makefile = Object.values(MAKEFILE)[0] ?? ''
    const lines = makeRecipe(makefile, 'mock-ui-pack-e2e')
      .split('\n')
      .map((line) => line.trim())
    // a live line (not commented out, no `-` ignore-errors prefix) that runs the command
    expect(lines.some((line) => line.startsWith(RUN_COMMAND))).toBe(true)
    const ciInner = makeRecipe(makefile, 'ci-inner')
    // the container has no Docker CLI: the e2e itself is never part of ci-inner
    expect(ciInner).not.toContain('mock-ui-pack-e2e.ts')
  })
})

describe('the path filter (Story 68.10 AC-3.1, AC-3.2)', () => {
  it.each([
    'apps/web/src/routes/+page.svelte',
    'apps/api/src/app.ts',
    'packages/extension-api/src/index.ts',
    'packages/composition-kit/src/cli.ts',
    'packages/shared/src/index.ts',
    'packages/db/src/schema/index.ts',
    'packages/crypto/src/index.ts',
    'packages/agent/src/index.ts',
    'packages/eslint-config/index.js',
    'packages/tsconfig/base.json',
    'fixtures/mock-ui-pack/module/index.ts',
    'fixtures/mock-sso-extension/src/index.ts',
    'scripts/lib/web-host/consumer-tarballs.ts',
    'scripts/web-host-consumer-fixture/compose-mock-pack.sh',
    'scripts/e2e-stack.sh',
    'docker-compose.mock-ui-pack.yml',
    'docker-compose.yml',
    'apps/api/Dockerfile',
    'Dockerfile.ci',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    'apps/web/e2e/mechanism/m1-page-override.spec.ts',
    'apps/web/playwright.mechanism.config.ts',
  ])('runs the job for %s', (path) => {
    expect(decide([path]).run).toBe(true)
  })

  it.each([
    'docs/architecture.md',
    'README.md',
    'packages/cli/src/index.ts',
    'packages/vault-action/src/main.ts',
  ])('skips %s with an explicit reason', (path) => {
    expect(decide([path])).toEqual({ run: false, reason: 'skipped: no matching paths' })
  })

  it('runs when any one of several changed files matches, and skips an empty diff', () => {
    expect(decide(['docs/a.md', 'apps/web/src/a.ts']).run).toBe(true)
    expect(decide([]).run).toBe(false)
  })

  it('fails OPEN for a workspace directory nobody classified', () => {
    expect(decide(['packages/brand-new/src/index.ts']).run).toBe(true)
    expect(decide(['apps/brand-new/src/index.ts']).reason).toContain('not classified')
  })

  it('classifies every real apps/* and packages/* directory, with a reason for each irrelevant one', () => {
    const dirs = Object.keys(WORKSPACE_MANIFESTS)
      .map((key) => key.slice('../'.length, -'/package.json'.length))
      .toSorted()
    expect(dirs.length).toBeGreaterThan(5)
    for (const dir of dirs) {
      const known = WORKSPACE_CLASSES.get(dir)
      expect(known, `${dir} is not classified in WORKSPACE_CLASSES`).toBeDefined()
      if (known?.runs === false) expect(known.reason, dir).toBeTruthy()
    }
    // and nothing classified that no longer exists
    expect([...WORKSPACE_CLASSES.keys()].filter((dir) => !dirs.includes(dir))).toEqual([])
  })

  it('fails OPEN when the diff cannot be computed or the base ref is unusable', () => {
    const broken = filterFor('main', () => {
      throw new Error('fatal: ambiguous argument origin/main...HEAD')
    })
    expect(broken.run).toBe(true)
    expect(broken.reason).toContain('could not compute the diff')
    expect(filterFor('--upload-pack=x').run).toBe(true)
    expect(filterFor('').run).toBe(true)
    expect(filterFor('main', () => ['docs/a.md']).run).toBe(false)
    expect(filterFor('main', () => ['apps/web/a.ts']).run).toBe(true)
  })
})

describe('the mechanism specs cannot pass vacuously (Story 68.10 AC-3.3)', () => {
  const byName = new Map(
    Object.entries(SPECS).map(([path, text]) => [path.split('/').at(-1) ?? path, text])
  )
  // This list is deliberately explicit; adding a capability spec must update it.
  const REQUIRED = [
    'm1-page-override.spec.ts',
    'm2-new-pages.spec.ts',
    'm3-injection.spec.ts',
    'm4-component-replacement.spec.ts',
    'm5-navigation.spec.ts',
    'm6-theme.spec.ts',
    'm7-api-routes.spec.ts',
  ]

  it('has one spec file per capability, each with a positive and a failure case in its titles', () => {
    for (const file of REQUIRED) {
      const text = byName.get(file) ?? ''
      expect(text, `${file} is missing`).not.toBe('')
      const titles = [...text.matchAll(/\btest\(\s*'([^']*)'|\btest\(\s*\n\s*'([^']*)'/g)].map(
        (match) => match[1] ?? match[2] ?? ''
      )
      expect(
        titles.some((title) => /^(works|positive)\b/.test(title)),
        `${file}: no positive`
      ).toBe(true)
      expect(
        titles.some((title) => /^fails\b/.test(title) && /fails|denied|rejected/.test(title)),
        `${file}: no failure case`
      ).toBe(true)
    }
  })

  it('has no skipped, focused, expected-to-fail or conditionally skipped test', () => {
    for (const [path, text] of Object.entries(SPECS)) {
      expect(text, path).not.toMatch(
        /\b(test|describe)\.(skip|fixme|fail|only)\b|\.only\(|test\.skip\(|\btest\.slow\(/
      )
    }
  })

  it('pins forbidOnly, zero retries and no trace, video or screenshot in the mechanism config', () => {
    const config = Object.values(CONFIG)[0] ?? ''
    expect(config).toContain('forbidOnly: true')
    expect(config).toContain('retries: 0')
    expect(config).toContain("trace: 'off'")
    expect(config).toContain("video: 'off'")
    expect(config).toContain("screenshot: 'off'")
    expect(config).toContain('workers: 1')
    expect(config).toContain('playwright-mechanism-output')
  })

  it('lists the mechanism config in the e2e tsconfig so no spec goes untypechecked', () => {
    const tsconfig = REPO_TEXT.get('../apps/web/e2e/tsconfig.json') ?? ''
    expect(tsconfig).toContain('../playwright.mechanism.config.ts')
    expect(tsconfig).toContain('"**/*.ts"')
  })
})

describe('the composed image and stack flavour (Story 68.10 AC-2.2, AC-2.4, AC-2.5)', () => {
  const read = (path: string): string => {
    const key = path.startsWith('scripts/') ? `./${path.slice('scripts/'.length)}` : `../${path}`
    const text = REPO_TEXT.get(key)
    expect(text, `${path} is not loaded`).toBeTruthy()
    return text ?? ''
  }

  it('pins the base image by digest, has a .dockerignore and builds from the composed context only', () => {
    const dockerfile = read('fixtures/mock-ui-pack/docker/web.Dockerfile')
    const froms = dockerfile.split('\n').filter((line) => line.startsWith('FROM '))
    expect(froms.length).toBeGreaterThanOrEqual(2)
    for (const line of froms) expect(line, line).toMatch(/^FROM node@sha256:[0-9a-f]{64} AS /)
    const code = dockerfile.split('\n').filter((line) => !line.trim().startsWith('#'))
    expect(code.join('\n')).not.toMatch(/apps\/web|packages\//)
    expect(read('fixtures/mock-ui-pack/docker/.dockerignore')).toContain('node_modules')
  })

  it('layers on the e2e override, gates the fault service behind a profile and rebinds ports to loopback', () => {
    const override = read('docker-compose.mock-ui-pack.yml')
    expect(override).toMatch(/api-faulty:\n\s+profiles: \['fault'\]/)
    for (const port of ['API_HOST_PORT', 'WEB_HOST_PORT', 'DB_HOST_PORT']) {
      expect(override).toContain(`'127.0.0.1:\${${port}:?`)
    }
    expect(override).toContain("INCLUDE_MOCK_UI_PACK_MODULE: 'true'")
    expect(override).toContain("VAULT_EXTENSIONS_REQUIRED: 'true'")
    const stack = read('scripts/e2e-stack.sh')
    expect(stack).toContain('-f docker-compose.e2e.yml')
    expect(stack).toContain('-f docker-compose.mock-ui-pack.yml')
  })
})
