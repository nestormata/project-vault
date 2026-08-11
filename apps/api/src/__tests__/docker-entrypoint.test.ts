/* eslint-disable security/detect-non-literal-fs-filename -- test exercises dynamic temp-dir paths */
// Story 9.9 AC-1/AC-2/AC-6: lightweight, no-Docker-required unit test of docker-entrypoint.sh's
// chown-then-drop-privileges logic. Runs the real script (`sh docker-entrypoint.sh`) with a
// stubbed PATH containing fake `chown`/`chmod`/`su-exec` executables so the test can assert on
// *behavior* (what got called, in what order, whether su-exec always runs) without needing real
// root privileges or a container.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ENTRYPOINT = join(import.meta.dirname, '..', '..', 'docker-entrypoint.sh')
const SU_EXEC_CALL = 'su-exec node:node true'

/** Builds a fake PATH dir with stub `mkdir`/`chown`/`chmod`/`su-exec` binaries that log their
 * invocation to `${binDir}/calls.log` and exit with the given status codes. Real `mkdir` is used
 * unless overridden (the script needs a real directory to exist for the rest of the test). */
function makeFakeBin(opts: { chownExit?: number; chmodExit?: number; mkdirExit?: number }): {
  binDir: string
  callsLogPath: string
} {
  const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-fakebin-'))
  const callsLogPath = join(binDir, 'calls.log')
  writeFileSync(callsLogPath, '')

  const stub = (name: string, exitCode: number, useReal?: string): void => {
    const real = useReal ? `\n${useReal} "$@"\nrc=$?\n` : '\n'
    const body = `#!/bin/sh\necho "${name} $*" >> "${callsLogPath}"${real}exit ${useReal ? '$rc' : exitCode}\n`
    const path = join(binDir, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }

  stub('mkdir', opts.mkdirExit ?? 0, opts.mkdirExit === undefined ? '/bin/mkdir' : undefined)
  stub('chown', opts.chownExit ?? 0)
  stub('chmod', opts.chmodExit ?? 0)
  stub('su-exec', 0)
  stub('cat', 0, '/bin/cat')
  stub('rm', 0, '/bin/rm')

  return { binDir, callsLogPath }
}

function runEntrypoint(
  env: Record<string, string>,
  binDir: string
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('sh', [ENTRYPOINT, 'true'], {
    env: { ...env, PATH: `${binDir}:/bin:/usr/bin` },
    encoding: 'utf8',
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  }
}

describe('Story 9.9: docker-entrypoint.sh', () => {
  let dirsToClean: string[] = []

  afterEach(() => {
    for (const d of dirsToClean) rmSync(d, { recursive: true, force: true })
    dirsToClean = []
  })

  it('skips backup directory prep entirely and still execs su-exec when BACKUP_STORAGE_PATH is unset (AC-5/S3-only case)', () => {
    const { binDir, callsLogPath } = makeFakeBin({})
    dirsToClean.push(binDir)

    const result = runEntrypoint({}, binDir)
    expect(result.status).toBe(0)

    const calls = readFileSync(callsLogPath, 'utf8')
    expect(calls).not.toContain('mkdir')
    expect(calls).not.toContain('chown')
    expect(calls).toContain(SU_EXEC_CALL)
  })

  it('chowns and chmods the configured directory to 1000:1000 / 0750, then execs su-exec (AC-1)', () => {
    const { binDir, callsLogPath } = makeFakeBin({})
    dirsToClean.push(binDir)
    const backupPath = mkdtempSync(join(tmpdir(), 'entrypoint-backupdir-'))
    dirsToClean.push(backupPath)

    const result = runEntrypoint({ BACKUP_STORAGE_PATH: backupPath }, binDir)
    expect(result.status).toBe(0)

    const calls = readFileSync(callsLogPath, 'utf8')
    expect(calls).toMatch(new RegExp(`chown 1000:1000 ${backupPath}`))
    expect(calls).toMatch(new RegExp(`chmod 0750 ${backupPath}`))
    expect(calls).toContain(SU_EXEC_CALL)
    // chown/chmod must run BEFORE su-exec (privilege drop happens last, right before exec).
    expect(calls.indexOf('chown')).toBeLessThan(calls.indexOf('su-exec'))
  })

  it('does not recurse: only the configured directory itself is targeted, never a -R flag', () => {
    const entrypointSrc = readFileSync(ENTRYPOINT, 'utf8')
    expect(entrypointSrc).not.toMatch(/chown\s+-R/)
    expect(entrypointSrc).not.toMatch(/chmod\s+-R/)
  })

  it('an unfixable mount (chown fails) logs the required uid/gid and still execs su-exec — startup is never aborted (AC-2)', () => {
    const { binDir, callsLogPath } = makeFakeBin({ chownExit: 1 })
    dirsToClean.push(binDir)
    const backupPath = mkdtempSync(join(tmpdir(), 'entrypoint-unfixable-'))
    dirsToClean.push(backupPath)

    const result = runEntrypoint({ BACKUP_STORAGE_PATH: backupPath }, binDir)

    // Must still start the app (exit 0, su-exec invoked) — only the backup path degrades.
    expect(result.status).toBe(0)
    const calls = readFileSync(callsLogPath, 'utf8')
    expect(calls).toContain(SU_EXEC_CALL)
    // Structured warning on stderr with the exact remediation UID/GID.
    expect(result.stderr).toMatch(/backup\.storage_init_failed/)
    expect(result.stderr).toMatch(/1000/)
    expect(result.stderr).toMatch(/1000/)
  })

  it('an unwritable mkdir failure also logs a warning and still execs su-exec, never aborting startup', () => {
    const { binDir, callsLogPath } = makeFakeBin({ mkdirExit: 1 })
    dirsToClean.push(binDir)

    const result = runEntrypoint({ BACKUP_STORAGE_PATH: '/nonexistent/unwritable/path' }, binDir)

    expect(result.status).toBe(0)
    const calls = readFileSync(callsLogPath, 'utf8')
    expect(calls).toContain(SU_EXEC_CALL)
    expect(result.stderr).toMatch(/backup\.storage_init_failed/)
  })

  it('an existing, already-correctly-owned destination is repaired in place (idempotent, no error)', () => {
    const { binDir, callsLogPath } = makeFakeBin({})
    dirsToClean.push(binDir)
    const backupPath = mkdtempSync(join(tmpdir(), 'entrypoint-existing-'))
    dirsToClean.push(backupPath)
    mkdirSync(join(backupPath, 'already-here'), { recursive: true })
    writeFileSync(join(backupPath, 'backup_existing.vault'), 'preexisting content')

    const result = runEntrypoint({ BACKUP_STORAGE_PATH: backupPath }, binDir)

    expect(result.status).toBe(0)
    expect(readFileSync(join(backupPath, 'backup_existing.vault'), 'utf8')).toBe(
      'preexisting content'
    )
    const calls = readFileSync(callsLogPath, 'utf8')
    expect(calls).toContain(SU_EXEC_CALL)
  })
})
