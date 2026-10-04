/**
 * Story 66.21 — tests for the public-repo no-agent-attribution guard.
 *
 * Every offending phrase is assembled from fragments so this file never contains a literal
 * trailer or footer line (the guard scans commit messages and PR text, never file contents).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { trustedGit } from './lib/trusted-executable.js'
import { findAttribution, runCheck } from './check-no-agent-attribution.js'

const AGENT = 'Cla' + 'ude'
const AGENT_ADDRESS = 'noreply@' + 'anthro' + 'pic.com'
const COAUTHOR_KEY = 'Co-Authored' + '-By'
const SESSION_KEY = AGENT + '-Session'
const SESSION_URL = 'https://' + 'claude' + '.ai/code/' + 'session' + '_01ABC'

const BRANCH = 'feature'
const CLEAN_COMMIT = 'feat: clean change'
const agentCoAuthor = `${COAUTHOR_KEY}: ${AGENT} Sonnet <${AGENT_ADDRESS}>`
const footer = `\u{1F916} Gener` + `ated with [${AGENT} Code](https://claude.com/claude-code)`

describe('findAttribution', () => {
  it('passes a clean message with a prose body', () => {
    expect(findAttribution('fix(api): handle empty org\n\nThe loader returned early.')).toEqual([])
  })

  it('flags an agent co-author trailer', () => {
    const found = findAttribution(`fix: x\n\nbody\n\n${agentCoAuthor}`)
    expect(found).toHaveLength(1)
    expect(found[0]?.rule).toBe('agent-co-author')
    expect(found[0]?.line).toBe(agentCoAuthor)
  })

  it.each([
    'Copi' + 'lot',
    'Co' + 'dex',
    'Open' + 'AI',
    'Gemi' + 'ni',
    'Chat' + 'GPT',
    'gp' + 't-5',
  ])('flags a co-author named %s', (name) => {
    expect(findAttribution(`${COAUTHOR_KEY}: ${name} <bot@example.com>`)).toHaveLength(1)
  })

  it('flags an anthropic address under any name', () => {
    expect(findAttribution(`${COAUTHOR_KEY}: Some Name <a@${'anthro' + 'pic.com'}>`)).toHaveLength(
      1
    )
  })

  it('flags trailers after a bare carriage return, in a bullet, or in a quote', () => {
    expect(findAttribution(`text\r${agentCoAuthor}`)).toHaveLength(1)
    expect(findAttribution(`- ${agentCoAuthor}`)).toHaveLength(1)
    expect(findAttribution(`> ${agentCoAuthor}`)).toHaveLength(1)
  })

  it('passes a human co-author', () => {
    expect(findAttribution(`${COAUTHOR_KEY}: Ada Lovelace <ada@example.com>`)).toEqual([])
  })

  it('matches the trailer key in any case', () => {
    expect(findAttribution(agentCoAuthor.toLowerCase())).toHaveLength(1)
    expect(findAttribution(agentCoAuthor.toUpperCase())).toHaveLength(1)
  })

  it('flags a session trailer and a session URL anywhere', () => {
    expect(findAttribution(`${SESSION_KEY}: ${SESSION_URL}`).length).toBeGreaterThan(0)
    expect(findAttribution(`see ${SESSION_URL} for context`)).toHaveLength(1)
  })

  it('flags a Generated-with footer with and without the emoji', () => {
    expect(findAttribution(footer)).toHaveLength(1)
    expect(findAttribution(footer.replace('\u{1F916} ', ''))).toHaveLength(1)
    expect(findAttribution('Gener' + 'ated with Co' + 'dex')).toHaveLength(1)
    expect(findAttribution('Gener' + 'ated with Chat' + 'GPT')).toHaveLength(1)
  })

  it('does not flag prose that merely mentions the assistant or the rule', () => {
    expect(findAttribution(`docs: note that ${AGENT} must not add co-author lines`)).toEqual([])
    expect(findAttribution('Generated with the OpenAPI generator')).toEqual([])
    expect(findAttribution('chore(deps): bump x\n\nBumps x by dependabot[bot].')).toEqual([])
  })

  it('sees through zero-width and compatibility-form evasions', () => {
    const zeroWidth = `${COAUTHOR_KEY}: ${AGENT.slice(0, 2)}​${AGENT.slice(2)} <x@example.com>`
    expect(findAttribution(zeroWidth)).toHaveLength(1)
    const fullWidth = `${COAUTHOR_KEY}: Ｃ${AGENT.slice(1)} <x@example.com>`
    expect(findAttribution(fullWidth)).toHaveLength(1)
  })
})

describe('runCheck', () => {
  let dir: string

  function git(...args: string[]): string {
    return trustedGit(dir, ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args])
  }

  function commit(message: string): void {
    git('commit', '--allow-empty', '--no-gpg-sign', '-m', message)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attr-check-'))
    git('init', '-q', '-b', 'main')
    // Old, already-merged breach on the base side: history must never be scanned.
    commit(`chore: old\n\n${agentCoAuthor}`)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes a clean branch even though the base holds an old offending commit', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit('feat: clean change\n\nProse only.')
    const result = runCheck({ cwd: dir, base: 'main', env: {} })
    expect(result.code).toBe(0)
    expect(result.lines).toEqual([])
  })

  it('fails naming the sha when the last commit carries an agent trailer', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(CLEAN_COMMIT)
    commit(`feat: bad change\n\n${agentCoAuthor}`)
    const sha = git('rev-parse', 'HEAD').trim()
    const result = runCheck({ cwd: dir, base: 'main', env: {} })
    expect(result.code).toBe(1)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toContain(sha)
    expect(result.lines[0]).toContain('agent-co-author')
  })

  it('does not flag main commits when the branch merged main in', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(CLEAN_COMMIT)
    git('checkout', '-q', 'main')
    commit(`chore: later main commit\n\n${agentCoAuthor}`)
    git('checkout', '-q', BRANCH)
    git('merge', '--no-gpg-sign', '--no-ff', '-m', 'Merge branch main', 'main')
    const result = runCheck({ cwd: dir, base: 'main', env: {} })
    expect(result.code).toBe(0)
  })

  it('fails closed on an unknown base', () => {
    const result = runCheck({ cwd: dir, base: 'origin/does-not-exist', env: {} })
    expect(result.code).not.toBe(0)
    expect(result.lines.join('\n')).toMatch(/cannot read commits/i)
  })

  it('treats unset and empty PR text as nothing to scan', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(CLEAN_COMMIT)
    expect(runCheck({ cwd: dir, base: 'main', env: {} }).code).toBe(0)
    expect(runCheck({ cwd: dir, base: 'main', env: { PR_TITLE: '', PR_BODY: '' } }).code).toBe(0)
  })

  it('fails on an offending PR body (footer plus session URL)', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(CLEAN_COMMIT)
    const body = `Summary\n\n${footer}\n\n${SESSION_URL}`
    const result = runCheck({ cwd: dir, base: 'main', env: { PR_BODY: body } })
    expect(result.code).toBe(1)
    expect(result.lines.every((l) => l.includes('PR body'))).toBe(true)
    expect(result.lines.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a base that looks like a git option (exit 2, no option injection)', () => {
    const result = runCheck({ cwd: dir, base: '--output=injected.txt', env: {} })
    expect(result.code).toBe(2)
    expect(result.lines.join('\n')).toMatch(/must not start with/)
  })

  it('still scans a trailer hidden after a record-separator control character', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(`feat: sneaky\n\nprose\u001e\n${agentCoAuthor}`)
    const result = runCheck({ cwd: dir, base: 'main', env: {} })
    expect(result.code).toBe(1)
  })

  it('fails on an offending PR title', () => {
    git('checkout', '-q', '-b', BRANCH)
    commit(CLEAN_COMMIT)
    const result = runCheck({ cwd: dir, base: 'main', env: { PR_TITLE: footer } })
    expect(result.code).toBe(1)
    expect(result.lines[0]).toContain('PR title')
  })
})
