import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { runWriteEnv, successLine, type WriteEnvArgs } from './write-env-command.js'

const validConfig = {
  apiKey: 'pk_abc',
  baseUrl: 'https://vault.example.com',
  projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pvault-write-env-cmd-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeStreams() {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => void stdoutChunks.push(chunk) },
    stderr: { write: (chunk: string) => void stderrChunks.push(chunk) },
    isTTY: false,
    stdoutChunks,
    stderrChunks,
  }
}

function run(args: Partial<WriteEnvArgs>, config = validConfig) {
  const streams = makeStreams()
  const getSecret = vi.fn(async (name: string) => `value-of-${name}`)
  const createVaultAgent = vi.fn().mockReturnValue({ getSecret })
  const promise = runWriteEnv(
    { secrets: ['A'], output: '.env', force: false, format: 'dotenv', ...args },
    config,
    streams,
    { createVaultAgent, cwd: dir, checkGitIgnored: async () => 'unknown' }
  )
  return { promise, streams, createVaultAgent, getSecret }
}

describe('successLine (AC-4)', () => {
  it('singular / plural, sanitized path, offline-cache suffix', () => {
    expect(successLine({ path: '/a/.env', count: 1, servedFromCacheCount: 0 })).toBe(
      'Wrote 1 secret to /a/.env\n'
    )
    expect(successLine({ path: '/a/\u001b[2J.env', count: 3, servedFromCacheCount: 1 })).toBe(
      'Wrote 3 secrets to /a/[2J.env (1 served from offline cache, may be stale)\n'
    )
  })
})

describe('runWriteEnv — CLI adapter', () => {
  it('success → exit 0, exactly one stderr line with the absolute path, stdout empty', async () => {
    const { promise, streams } = run({ secrets: ['A', 'b=B'] })
    expect(await promise).toBe(0)
    expect(streams.stderrChunks).toEqual([`Wrote 2 secrets to ${join(dir, '.env')}\n`])
    expect(streams.stdoutChunks).toEqual([])
  })

  it.each([
    ['missing --output', { output: undefined }, /requires --output/],
    ['empty --output', { output: '' }, /requires --output/],
    ['--output - (stdout)', { output: '-' }, /pvault get.*pvault run --/],
    ['--format DOTENV', { format: 'DOTENV' }, /valid values: dotenv, shell/],
    ['--format env', { format: 'env' }, /valid values: dotenv, shell/],
    ['--format ""', { format: '' }, /valid values: dotenv, shell/],
  ])('%s → usage error 1 before any agent/network call', async (_l, args, message) => {
    const { promise, streams, createVaultAgent } = run(args)
    expect(await promise).toBe(EXIT_CODES.usageError)
    expect(streams.stderrChunks.join('')).toMatch(message)
    expect(createVaultAgent).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('zero --secret flags → 22 naming --secret', async () => {
    const { promise, streams } = run({ secrets: [] })
    expect(await promise).toBe(EXIT_CODES.secretsRequired)
    expect(streams.stderrChunks.join('')).toContain(
      'pvault write-env requires at least one --secret'
    )
  })

  it('non-UUID project id → 1, no agent', async () => {
    const { promise, createVaultAgent } = run({}, { ...validConfig, projectId: 'name' })
    expect(await promise).toBe(EXIT_CODES.usageError)
    expect(createVaultAgent).not.toHaveBeenCalled()
  })

  it('a seam failure is printed on stderr and its exit code returned', async () => {
    const { promise, streams } = run({ secrets: ['x=NODE_OPTIONS'] })
    expect(await promise).toBe(EXIT_CODES.usageError)
    expect(streams.stderrChunks.join('')).toMatch(/^Refusing to write reserved/)
    expect(streams.stdoutChunks).toEqual([])
  })
})
