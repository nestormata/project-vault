import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkGitIgnored, type ExecFileLike } from './git-ignore-check.js'

type Callback = Parameters<ExecFileLike>[3]
const NOT_IGNORED = 'not-ignored'

function fakeExecFile(respond: (cb: Callback) => void) {
  return vi.fn<ExecFileLike>((_file, _args, _options, cb) => {
    respond(cb)
  })
}

function exitError(
  code: number | string,
  killed = false
): Error & { code?: number | string; killed?: boolean } {
  return Object.assign(new Error('failed'), { code, killed })
}

describe('checkGitIgnored (AC-9) — per exit-status branch, fail-open', () => {
  it('exit 0 → ignored', async () => {
    await expect(
      checkGitIgnored(
        '/d',
        'f',
        fakeExecFile((cb) => cb(null))
      )
    ).resolves.toBe('ignored')
  })

  it('exit 1 → not-ignored', async () => {
    await expect(
      checkGitIgnored(
        '/d',
        'f',
        fakeExecFile((cb) => cb(exitError(1)))
      )
    ).resolves.toBe(NOT_IGNORED)
  })

  it.each([
    ['exit 128 (not a repo)', exitError(128)],
    ['git not installed (ENOENT)', exitError('ENOENT')],
    ['timeout (killed)', exitError(1, true)],
  ])('%s → unknown', async (_l, error) => {
    await expect(
      checkGitIgnored(
        '/d',
        'f',
        fakeExecFile((cb) => cb(error))
      )
    ).resolves.toBe('unknown')
  })

  it('a synchronous throw from execFile → unknown', async () => {
    const execFile: ExecFileLike = () => {
      throw new Error('spawn EAGAIN')
    }
    await expect(checkGitIgnored('/d', 'f', execFile)).resolves.toBe('unknown')
  })

  it('passes a hostile path verbatim as one argv element after "--", with a 2s timeout (no shell)', async () => {
    const execFile = fakeExecFile((cb) => cb(null))
    const hostile = '-rf $(touch pwned) with spaces'
    await checkGitIgnored('/some dir/-x', hostile, execFile)
    const [file, args, options] = execFile.mock.calls[0] ?? []
    expect(file).toBe('git')
    expect(args).toEqual(['-C', '/some dir/-x', 'check-ignore', '-q', '--', hostile])
    expect(options?.timeout).toBe(2000)
    expect(options).not.toHaveProperty('shell')
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
      expect(options?.env).not.toHaveProperty(key)
    }
  })
})

const gitAvailable = !spawnSync('git', ['--version']).error

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['GIT_DIR']
  delete env['GIT_WORK_TREE']
  delete env['GIT_INDEX_FILE']
  return env
}

describe.skipIf(!gitAvailable)('checkGitIgnored — real git in a mkdtemp repo', () => {
  it('distinguishes ignored, not-ignored, and not-a-repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pvault-git-check-'))
    const outside = mkdtempSync(join(tmpdir(), 'pvault-git-outside-'))
    try {
      spawnSync('git', ['init', '-q', repo], { env: gitEnv() })
      writeFileSync(join(repo, '.gitignore'), 'ignored.env\n')
      await expect(checkGitIgnored(repo, 'ignored.env')).resolves.toBe('ignored')
      await expect(checkGitIgnored(repo, 'plain.env')).resolves.toBe(NOT_IGNORED)
      await expect(checkGitIgnored(repo, '-leading dash $(x).env')).resolves.toBe(NOT_IGNORED)
      await expect(checkGitIgnored(outside, '.env')).resolves.toBe('unknown')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
