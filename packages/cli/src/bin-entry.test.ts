import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.js'

/**
 * Story 43.2 — `runCli()` is the real entry point (see bin.ts): it wires the actual Node
 * process streams/env instead of the fakes every other cli.test.ts scenario injects. It was
 * previously untested, leaving lines that build the real streams object and the
 * exitOverride()-catch mapping (a CommanderError -> process.exitCode) uncovered. These tests
 * drive it end to end, only stubbing process.stdout/stderr.write to keep the real CLI output
 * out of the test runner's own stdout.
 */
describe('runCli — real entry point', () => {
  let xdgHome: string
  let originalXdgConfigHome: string | undefined
  let originalExitCode: number | string | undefined | null
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    xdgHome = mkdtempSync(join(tmpdir(), 'pvault-bin-entry-test-'))
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = xdgHome
    originalExitCode = process.exitCode
    process.exitCode = undefined
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    if (originalXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME']
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome
    }
    process.exitCode = originalExitCode
    rmSync(xdgHome, { recursive: true, force: true })
  })

  it('runs a real command (logout, no session file) end to end and sets process.exitCode via setExitCode', async () => {
    await runCli(['node', 'pvault', 'logout'])

    expect(process.exitCode).toBe(0)
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Not logged in.'))
  })

  it('maps a commander parse failure (unknown command) to a non-zero process.exitCode instead of throwing', async () => {
    await expect(runCli(['node', 'pvault', 'not-a-real-command'])).resolves.toBeUndefined()

    expect(process.exitCode).not.toBe(0)
    expect(typeof process.exitCode).toBe('number')
  })

  it('maps --version (a zero-exitCode CommanderError) to process.exitCode 0', async () => {
    await runCli(['node', 'pvault', '--version'])

    expect(process.exitCode).toBe(0)
  })
})
