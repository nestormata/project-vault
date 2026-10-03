import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './pack-web-host.js'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'
import {
  consumerFixtureEnv,
  packConsumerTarballs,
  type ConsumerTarballs,
} from './lib/web-host/consumer-tarballs.js'

// Story 68.10 AC-2.1: the compose stage of the mechanism e2e. The mock UI pack
// (fixtures/mock-ui-pack/ui-pack) is composed onto the REAL packed web-host in the kit's isolated
// consumer (fresh temp dir outside the repository, `env -i`, packed tarballs only), then `pv-compose
// --check`, `pv-verify --only guards` (including the monolithic-region guard and its
// CM-exemption proof), svelte-check, the shipped unit tests, vite build, boot and HTTP/CSS assertions
// for M1, M2, M3 (public points), M4 and M6. The steps live in
// scripts/web-host-consumer-fixture/compose-mock-pack.sh, driven through run.sh. It reuses the
// pack-and-compose libraries of the kit integration test (scripts/lib/web-host/consumer-tarballs.ts).
//
// Slow (a clean npm install and a Vite build), so it runs only with MOCK_UI_PACK_COMPOSE=1
// (`make mock-ui-pack-compose`).

const ENABLED = process.env.MOCK_UI_PACK_COMPOSE === '1'
const FIXTURE_SCRIPT = join(REPO_ROOT, 'scripts', 'web-host-consumer-fixture', 'run.sh')
const UI_PACK_DIR = join(REPO_ROOT, 'fixtures', 'mock-ui-pack', 'ui-pack')
const TIMEOUT_MS = 1_800_000
const VARIANT = 'compose-mock-pack'

if (!ENABLED) {
  process.stderr.write(
    '\n*** SKIPPED: the mock UI pack compose stage (Story 68.10) did NOT run. ***\n' +
      '*** Run it with `make mock-ui-pack-compose`.                            ***\n\n'
  )
}

let workDir = ''
let tarballs: ConsumerTarballs

describe.runIf(ENABLED)('mock UI pack compose stage (Story 68.10 AC-2.1)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'mock-ui-pack-compose-'))
    tarballs = await packConsumerTarballs(workDir)
    // The consumer harness copies COMPOSITION_KIT_FIXTURES/<pack name>: stage the UI pack tree alone
    // (the module pack and node_modules of the workspace package stay out of the composed copy).
    cpSync(UI_PACK_DIR, join(workDir, 'fixtures', 'mock-ui-pack'), { recursive: true })
  }, 600_000)

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
  })

  it(
    'composes, checks, verifies, builds, boots and serves the mock UI pack',
    () => {
      const env = consumerFixtureEnv(process.env, workDir, tarballs, {
        fixturesDir: join(workDir, 'fixtures'),
      })
      const run = spawnSync(
        resolveTrustedExecutable('bash'),
        [FIXTURE_SCRIPT, tarballs.webHostTarball, VARIANT],
        { encoding: 'utf8', env, timeout: TIMEOUT_MS }
      )
      const output = `${run.stdout}\n${run.stderr}`
      expect(run.status, output.slice(-9000)).toBe(0)
      for (const line of [
        'pv-compose --check',
        'OK: a monolithic region in a PV-originated file is red',
        'OK: the same markup in a CM-originated file is exempt (lock provenance)',
        'OK: M1 overrides (load, actions, 303, layout, error, hooks, app.html, static, removal)',
        'OK: M2 routes (page, endpoint, 405, depth, protected by derivation/add, public by remove)',
        'OK: M3 injection into a native public page (component, load, shell head) beside PV markup',
        'OK: M4 replacements and M6 tokens, own styles and @source utilities',
        'OK: a stale replacement hash fails the composition (exit 1) and names Footer.svelte',
      ]) {
        expect(output, line).toContain(line)
      }
    },
    TIMEOUT_MS
  )
})

describe('mock UI pack compose stage: wiring', () => {
  it('the UI pack keeps its overlay under ui-pack/ and never names a real CM file or secret', () => {
    const manifest = readFileSync(join(UI_PACK_DIR, 'pv-ui.manifest.ts'), 'utf8')
    expect(manifest).toContain("story: 'MOCK-UI-PACK'")
    expect(manifest).not.toMatch(/centralizeme|workos|secret/i)
  })

  it('the harness script knows the variant', () => {
    const script = readFileSync(
      join(REPO_ROOT, 'scripts/web-host-consumer-fixture/compose-mode.sh'),
      'utf8'
    )
    expect(script).toContain('compose-mock-pack) echo mock-ui-pack ;;')
  })
})
