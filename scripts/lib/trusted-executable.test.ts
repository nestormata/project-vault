import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './fixture-test-helpers.js'
import {
  TRUSTED_EXECUTABLE_DIRS,
  resolveBin,
  resolveTrustedExecutable,
  trustedGit,
} from './trusted-executable.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
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

function executable(dir: string, name: string): string {
  writeFixture(dir, name, '#!/bin/sh\nexit 0\n')
  const path = join(dir, name)
  chmodSync(path, 0o755)
  return path
}

describe('resolveTrustedExecutable', () => {
  it('searches only fixed, root-owned directories, never $PATH', () => {
    expect(TRUSTED_EXECUTABLE_DIRS).toEqual(['/usr/bin', '/usr/local/bin', '/bin'])
  })

  it('returns the executable in the first directory that has it', () => {
    const root = tempRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    const expected = executable(first, 'git')
    executable(second, 'git')
    expect(resolveTrustedExecutable('git', [first, second])).toBe(expected)
  })

  it('falls through to a later directory when earlier ones lack it', () => {
    const root = tempRoot()
    const empty = join(root, 'empty')
    writeFixture(empty, 'unrelated', '')
    const later = join(root, 'later')
    const expected = executable(later, 'docker')
    expect(resolveTrustedExecutable('docker', [empty, later])).toBe(expected)
  })

  it('skips a same-named file that is not executable', () => {
    const root = tempRoot()
    const first = join(root, 'first')
    writeFixture(first, 'git', 'not executable')
    chmodSync(join(first, 'git'), 0o644)
    const later = join(root, 'later')
    const expected = executable(later, 'git')
    expect(resolveTrustedExecutable('git', [first, later])).toBe(expected)
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
