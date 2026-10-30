// @vitest-environment node
/**
 * Story 72-20 AC-5: Node ends the process on an unhandled rejection, and Vitest installs its own
 * handler, so an in-process test cannot see that. This runs the real dashboard `load` in a child
 * Node process with the default unhandled-rejection mode, where an organization viewer's 403 on the
 * certificate and domain reads arrives while the project dashboard read is still in flight.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PROBE = fileURLToPath(new URL('../../../scripts/dashboard-load-probe.ts', import.meta.url))
const PROBE_TIMEOUT_MS = 90_000

describe('dashboard load in a plain Node process', () => {
  it('survives 403 asset reads and reports them as forbidden', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', PROBE], {
      cwd: WEB_ROOT,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    })

    expect(run.stderr).not.toMatch(/ApiClientError|UnhandledPromiseRejection/)
    expect(run.status).toBe(0)
    const lastLine = run.stdout.trim().split('\n').at(-1) ?? ''
    expect(JSON.parse(lastLine)).toEqual([
      { status: 'forbidden', count: 0 },
      { status: 'forbidden', count: 0 },
    ])
  }, 120_000)
})
