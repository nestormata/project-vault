import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './fixture-test-helpers.js'
import {
  TRUSTED_EXECUTABLE_DIRS,
  resolveBin,
  resolveTrustedExecutable,
  trustedGit,
} from './trusted-executable.js'

const REPO_ROOT = resolve(import.meta.dirname, '../..')
const AGENT_DIR = join(REPO_ROOT, 'packages/agent')
const VAULT_ACTION_DIR = join(REPO_ROOT, 'packages/vault-action')

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'trusted-executable-'))
  tempRoots.push(root)
  return root
}

/** An `isExecutable` stand-in that accepts exactly `paths`, for the pure search-order cases. */
function executableOnly(...paths: string[]): (path: string) => boolean {
  const accepted = new Set(paths)
  return (path) => accepted.has(path)
}

describe('resolveTrustedExecutable', () => {
  it('searches only fixed, root-owned directories, never $PATH', () => {
    expect(TRUSTED_EXECUTABLE_DIRS).toEqual(['/usr/bin', '/usr/local/bin', '/bin'])
  })

  it('returns the executable in the first directory that has it', () => {
    const isExecutable = executableOnly('/first/git', '/second/git')
    expect(resolveTrustedExecutable('git', ['/first', '/second'], isExecutable)).toBe('/first/git')
  })

  it('falls through to a later directory when earlier ones lack it', () => {
    const isExecutable = executableOnly('/later/docker')
    expect(resolveTrustedExecutable('docker', ['/empty', '/later'], isExecutable)).toBe(
      '/later/docker'
    )
  })

  it('skips a same-named file that is not executable (real file check)', () => {
    const root = tempRoot()
    const first = join(root, 'first')
    // writeFileSync creates files without execute bits (0o666 minus umask).
    writeFixture(first, 'git', 'not executable')
    const hostGitDir = dirname(resolveTrustedExecutable('git'))
    expect(resolveTrustedExecutable('git', [first, hostGitDir])).toBe(join(hostGitDir, 'git'))
  })

  it('throws, naming every searched directory, when the binary is nowhere', () => {
    const root = tempRoot()
    const a = join(root, 'a')
    const b = join(root, 'b')
    expect(() => resolveTrustedExecutable('git', [a, b])).toThrow(`git not found in ${a} or ${b}`)
  })

  it('the default directory list produces the documented message', () => {
    expect(() => resolveTrustedExecutable('git', TRUSTED_EXECUTABLE_DIRS, () => false)).toThrow(
      'git not found in /usr/bin, /usr/local/bin or /bin'
    )
  })

  it('finds git on this host by default (CI runners and dev hosts ship /usr/bin/git)', () => {
    const path = resolveTrustedExecutable('git')
    expect(isAbsolute(path)).toBe(true)
    expect(path.endsWith('/git')).toBe(true)
  })
})

describe('trustedGit', () => {
  it('runs the trusted git in the given directory and returns its stdout', () => {
    expect(trustedGit(REPO_ROOT, ['rev-parse', '--show-toplevel']).trim()).toBe(REPO_ROOT)
  })

  it('throws when git fails', () => {
    expect(() => trustedGit(REPO_ROOT, ['rev-parse', '--verify', 'no-such-ref-43-9'])).toThrow()
  })
})

describe('resolveBin', () => {
  it('resolves @vercel/ncc from packages/vault-action to its absolute cli.js', () => {
    const path = resolveBin('@vercel/ncc', 'ncc', VAULT_ACTION_DIR)
    expect(isAbsolute(path)).toBe(true)
    expect(path.endsWith(join('dist', 'ncc', 'cli.js'))).toBe(true)
  })

  it('resolves typescript from packages/agent to its absolute bin/tsc', () => {
    const path = resolveBin('typescript', 'tsc', AGENT_DIR)
    expect(isAbsolute(path)).toBe(true)
    expect(path.endsWith(join('bin', 'tsc'))).toBe(true)
  })

  it('throws when the package is not resolvable from the consuming package', () => {
    expect(() => resolveBin('@project-vault/definitely-not-a-package', 'x', AGENT_DIR)).toThrow(
      /@project-vault\/definitely-not-a-package/
    )
  })

  it('throws when the package has no bin entry of that name', () => {
    expect(() => resolveBin('typescript', 'not-a-bin', AGENT_DIR)).toThrow(
      'typescript has no bin entry named not-a-bin'
    )
  })

  it("packages/agent's build script is still exactly `tsc` (check-vault-action-dist runs tsc directly)", () => {
    const pkg = JSON.parse(readFileSync(join(AGENT_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['build']).toBe('tsc')
  })
})
