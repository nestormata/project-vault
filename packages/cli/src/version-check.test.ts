/* eslint-disable sonarjs/no-duplicate-string -- table-driven cases: each row spells its versions/URLs
   literally so the expected precedence or mapping is readable at a glance. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVaultAgent } from '@project-vault/agent'
import {
  evaluateVersionPolicy,
  policyEndpointUrl,
  runVersionCheck,
  VERSION_CHECK_TIMEOUT_MS,
  type RunVersionCheckOptions,
} from './version-check.js'
import type { CliVersionPolicy } from './version-policy-response.js'
import { versionCheckCachePath } from './version-check-cache.js'

const RELEASES = 'https://github.com/nestormata/project-vault/releases'
const BASE_URL = 'https://vault.example.com'
const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const REASON =
  'Session refresh sent the refresh token to the configured URL without TLS verification; upgrade immediately.'

function policy(overrides: Partial<CliVersionPolicy> = {}): CliVersionPolicy {
  return { current: '1.3.0', minimumSupported: null, withdrawn: [], ...overrides }
}

describe('evaluateVersionPolicy (precedence withdrawn > below-minimum > stale > server-older)', () => {
  it.each<[string, CliVersionPolicy, string]>([
    ['1.2.0', policy(), 'stale'],
    ['1.3.0', policy(), 'ok'],
    ['1.4.0', policy(), 'server-older'],
    ['1.4.0-rc.1', policy(), 'server-older'],
    ['1.3.0-rc.1', policy(), 'stale'],
    ['1.2.0', policy({ current: null }), 'ok'],
    ['1.0.7', policy({ minimumSupported: '1.1.0' }), 'below-minimum'],
    ['1.1.0', policy({ minimumSupported: '1.1.0', current: '1.1.0' }), 'ok'],
    ['1.1.0', policy({ minimumSupported: '1.1.0' }), 'stale'],
    ['1.0.0', policy({ current: null, minimumSupported: '1.1.0' }), 'below-minimum'],
    // contradictory policy (current < minimum) evaluated field-by-field
    ['1.0.5', policy({ current: '1.0.0', minimumSupported: '1.1.0' }), 'below-minimum'],
    [
      '1.2.1',
      policy({ minimumSupported: '1.3.0', withdrawn: [{ version: '1.2.1', reason: 'x' }] }),
      'withdrawn',
    ],
    ['1.2.10', policy({ withdrawn: [{ version: '1.2.1', reason: 'x' }] }), 'stale'],
    ['1.2.1-rc.1', policy({ withdrawn: [{ version: '1.2.1', reason: 'x' }] }), 'stale'],
    ['1.2.1', policy({ current: null, withdrawn: [{ version: '1.2.1-rc.1', reason: 'x' }] }), 'ok'],
    ['1.4.0', policy({ current: null }), 'ok'],
  ])('cli %s → %s … %s', (cli, pol, kind) => {
    expect(evaluateVersionPolicy(cli, pol).kind).toBe(kind)
  })

  it('an unparseable CLI version is never flagged', () => {
    expect(evaluateVersionPolicy('dev', policy()).kind).toBe('ok')
  })
})

describe('policyEndpointUrl (AC-3 URL join)', () => {
  it.each([
    ['https://h', 'https://h/api/v1/client-version-policy'],
    ['https://h/', 'https://h/api/v1/client-version-policy'],
    ['https://h//', 'https://h/api/v1/client-version-policy'],
    ['https://h/vault/', 'https://h/vault/api/v1/client-version-policy'],
    ['https://h/vault', 'https://h/vault/api/v1/client-version-policy'],
    ['https://h/vault?q=1#f', 'https://h/vault/api/v1/client-version-policy'],
  ])('%s → %s', (base, expected) => {
    expect(policyEndpointUrl(base)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------------------------

const tempDirs: string[] = []
function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pvault-version-check-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function jsonResponse(cli: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: { schemaVersion: 1, clients: { cli } } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type Harness = {
  opts: RunVersionCheckOptions
  stderr: string[]
  fetchFn: ReturnType<typeof vi.fn>
  clock: { now: number }
}

function harness(
  respond: (() => Promise<Response> | Response) | CliVersionPolicy,
  overrides: Partial<RunVersionCheckOptions> = {}
): Harness {
  const stderr: string[] = []
  const clock = { now: T0 }
  const fetchFn = vi.fn(async () =>
    typeof respond === 'function' ? respond() : jsonResponse(respond)
  )
  return {
    stderr,
    fetchFn,
    clock,
    opts: {
      baseUrl: BASE_URL,
      cliVersion: '1.2.0',
      fetchFn,
      now: () => clock.now,
      cacheDir: cacheDir(),
      writeStderr: (s) => void stderr.push(s),
      suppressNotices: false,
      ...overrides,
    },
  }
}

const STALE_NOTICE = `notice: pvault 1.2.0 is older than this server's release 1.3.0; download the matching pvault from ${RELEASES}\n`

describe('runVersionCheck — advisory notices (AC-1)', () => {
  it('prints the stale notice and does not refuse', async () => {
    const h = harness(policy())
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.stderr.join('')).toBe(STALE_NOTICE)
  })

  it('prints the below-minimum warning instead of (never with) the stale notice', async () => {
    const h = harness(policy({ minimumSupported: '1.1.0' }), { cliVersion: '1.0.7' })
    await runVersionCheck(h.opts)
    expect(h.stderr.join('')).toBe(
      `warning: pvault 1.0.7 is below this server's minimum supported version 1.1.0 and may stop working; upgrade from ${RELEASES}\n`
    )
  })

  it('prints the server-older notice', async () => {
    const h = harness(policy(), { cliVersion: '1.4.0' })
    await runVersionCheck(h.opts)
    expect(h.stderr.join('')).toBe(
      "notice: pvault 1.4.0 is newer than this server's release 1.3.0; some commands may not work until the server is upgraded\n"
    )
  })

  it('is silent when current', async () => {
    const h = harness(policy(), { cliVersion: '1.3.0' })
    await runVersionCheck(h.opts)
    expect(h.stderr).toEqual([])
  })

  it('never checks a dev build', async () => {
    const h = harness(policy(), { cliVersion: 'dev' })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.fetchFn).not.toHaveBeenCalled()
  })

  it('rate-limits the notice to once per 24 h (shared across advisory kinds) and caches 1 h', async () => {
    const h = harness(policy())
    await runVersionCheck(h.opts)
    h.clock.now = T0 + 30 * 60_000
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(1)
    h.clock.now = T0 + 2 * 3_600_000
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    expect(h.stderr).toEqual([STALE_NOTICE])
    h.clock.now = T0 + 24 * 3_600_000
    await runVersionCheck(h.opts)
    expect(h.stderr).toEqual([STALE_NOTICE, STALE_NOTICE])
  })

  it('PVAULT_NO_VERSION_CHECK suppresses the notice but still fetches and does not start the 24 h window', async () => {
    const h = harness(policy(), { suppressNotices: true })
    await runVersionCheck(h.opts)
    expect(h.stderr).toEqual([])
    expect(h.fetchFn).toHaveBeenCalledTimes(1)
    h.opts.suppressNotices = false
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(1)
    expect(h.stderr).toEqual([STALE_NOTICE])
  })

  it('an upgraded CLI ignores the old version entry (no inherited rate-limit)', async () => {
    const h = harness(policy())
    await runVersionCheck(h.opts)
    h.opts.cliVersion = '1.2.5'
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    expect(h.stderr).toHaveLength(2)
  })

  it('keeps separate entries per server', async () => {
    const h = harness(policy())
    await runVersionCheck(h.opts)
    h.opts.baseUrl = 'https://other.example.com/'
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    expect(h.stderr).toHaveLength(2)
  })

  it('a response carrying downloadUrl/url never influences output', async () => {
    const h = harness(() =>
      jsonResponse({
        ...policy(),
        downloadUrl: 'https://evil.example/',
        url: 'https://evil.example/',
      })
    )
    await runVersionCheck(h.opts)
    expect(h.stderr.join('')).not.toContain('evil')
    expect(h.stderr.join('')).toBe(STALE_NOTICE)
  })
})

describe('runVersionCheck — request hygiene (AC-3)', () => {
  it('sends only accept and user-agent, to the policy URL, with redirect: error', async () => {
    const h = harness(policy())
    await runVersionCheck(h.opts)
    const [url, init] = h.fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vault.example.com/api/v1/client-version-policy')
    expect(init.redirect).toBe('error')
    expect(init.method ?? 'GET').toBe('GET')
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
      'accept',
      'user-agent',
    ])
    expect((init.headers as Record<string, string>)['user-agent']).toBe('pvault/1.2.0')
    expect(JSON.stringify([url, init.headers])).not.toMatch(/pk_|authorization|x-vault/i)
  })

  it('never writes userinfo to the cache file', async () => {
    const h = harness(policy(), { baseUrl: 'https://u:p@vault.example.com/' })
    h.fetchFn.mockImplementation(async () => {
      throw new TypeError('Request cannot be constructed from a URL that includes credentials')
    })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    const raw = readFileSync(versionCheckCachePath(h.opts.cacheDir as string), 'utf8')
    expect(raw).not.toContain('u:p')
    expect(raw).toContain('https://vault.example.com')
  })
})

describe('runVersionCheck — unreachable / malformed (AC-3)', () => {
  it.each<[string, () => Promise<Response> | Response]>([
    ['connection refused', () => Promise.reject(new TypeError('fetch failed'))],
    ['404 (older server)', () => new Response('not found', { status: 404 })],
    ['500', () => new Response('x', { status: 500 })],
    ['503 sealed', () => jsonResponse({ status: 'sealed' }, 503)],
    ['429', () => new Response('x', { status: 429 })],
    ['redirect refused', () => Promise.reject(new TypeError('unexpected redirect'))],
    ['non-JSON', () => new Response('<html>', { status: 200 })],
    [
      'malformed policy',
      () => jsonResponse({ current: 'latest', minimumSupported: null, withdrawn: [] }),
    ],
    ['over 16 KiB', () => new Response(`{"x":"${'a'.repeat(17 * 1024)}"}`, { status: 200 })],
  ])('%s → proceed silently, negative-cache 10 min', async (_label, respond) => {
    const h = harness(respond)
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.stderr).toEqual([])
    h.clock.now = T0 + 9 * 60_000
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(1)
    h.clock.now = T0 + 10 * 60_000
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
  })

  it('aborts a black-holed request at 1500 ms', async () => {
    vi.useFakeTimers()
    const h = harness(() => new Promise<Response>(() => {}))
    let settled = false
    const pending = runVersionCheck(h.opts).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ refuse: false })
    expect(VERSION_CHECK_TIMEOUT_MS).toBe(1500)
    expect(h.stderr).toEqual([])
  })

  it('passes an AbortSignal that fires on timeout (for the real fetch)', async () => {
    vi.useFakeTimers()
    let captured: AbortSignal | undefined
    const h = harness(() => new Promise<Response>(() => {}))
    h.fetchFn.mockImplementation((_u: string, init: RequestInit) => {
      captured = init.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const pending = runVersionCheck(h.opts)
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_TIMEOUT_MS)
    await pending
    expect(captured?.aborted).toBe(true)
  })

  it('a stale cached ok policy is still used for notices while unreachable', async () => {
    const h = harness(policy(), { suppressNotices: true })
    await runVersionCheck(h.opts)
    h.fetchFn.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    h.clock.now = T0 + 2 * 3_600_000
    h.opts.suppressNotices = false
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    expect(h.stderr).toEqual([STALE_NOTICE])
  })

  it('a version-check failure never touches the agent fallback state', async () => {
    const h = harness(() => Promise.reject(new TypeError('fetch failed')))
    await runVersionCheck(h.opts)
    const agentFetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', agentFetch)
    try {
      const agent = createVaultAgent({
        apiKey: 'pk_x',
        baseUrl: BASE_URL,
        projectId: 'a1c2d3e4-0000-0000-0000-000000000000',
      })
      await agent.getSecret('X').catch(() => undefined)
      expect(agentFetch).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('works with no cache directory at all', async () => {
    const h = harness(policy(), { cacheDir: null })
    await runVersionCheck(h.opts)
    await runVersionCheck(h.opts)
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
  })

  it('an unparsable baseUrl makes no request', async () => {
    const h = harness(policy(), { baseUrl: 'not a url' })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.fetchFn).not.toHaveBeenCalled()
  })

  it('a corrupted cache file is treated as no cache', async () => {
    const h = harness(policy())
    const dir = h.opts.cacheDir as string
    mkdirSync(dir, { recursive: true })
    writeFileSync(versionCheckCachePath(dir), '{{{')
    await runVersionCheck(h.opts)
    expect(h.stderr).toEqual([STALE_NOTICE])
  })
})

describe('runVersionCheck — withdrawn (AC-2) and sticky verdict (AC-3 D9)', () => {
  const withdrawnPolicy = policy({ withdrawn: [{ version: '1.2.1', reason: REASON }] })

  it('refuses with exit 29 and the exact two-line message', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1' })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: true, exitCode: 29 })
    expect(h.stderr.join('')).toBe(
      `error: pvault 1.2.1 has been withdrawn by vault.example.com: ${REASON}\nDownload a supported release from ${RELEASES}\n`
    )
  })

  it('names "(no reason given)" for an empty reason', async () => {
    const h = harness(policy({ withdrawn: [{ version: '1.2.1', reason: '' }] }), {
      cliVersion: '1.2.1',
    })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: true, exitCode: 29 })
    expect(h.stderr.join('')).toBe(
      `error: pvault 1.2.1 has been withdrawn by vault.example.com (no reason given).\nDownload a supported release from ${RELEASES}\n`
    )
  })

  it('renders hostile reason text inertly', async () => {
    const h = harness(
      policy({ withdrawn: [{ version: '1.2.1', reason: '\x1b[2J\x1b[31mFAKE\u202E\nnext' }] }),
      { cliVersion: '1.2.1' }
    )
    await runVersionCheck(h.opts)
    expect(h.stderr[0]).toContain('vault.example.com: [2J[31mFAKE next\n')
  })

  it('is never suppressed by PVAULT_NO_VERSION_CHECK and never rate-limited', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1', suppressNotices: true })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: true, exitCode: 29 })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: true, exitCode: 29 })
    expect(h.stderr.filter((l) => l.startsWith('error:'))).toHaveLength(2)
  })

  it('always re-fetches while a withdrawn verdict is cached, and clears it when lifted', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1' })
    await runVersionCheck(h.opts)
    h.fetchFn.mockImplementation(async () => jsonResponse(policy({ current: '1.2.1' })))
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.fetchFn).toHaveBeenCalledTimes(2)
    h.fetchFn.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    h.clock.now = T0 + 2 * 3_600_000
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
  })

  it('stays refused while unreachable (sticky), naming the date and the cache path', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1', suppressNotices: true })
    await runVersionCheck(h.opts)
    h.stderr.length = 0
    h.fetchFn.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    h.clock.now = T0 + 5 * 24 * 3_600_000
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: true, exitCode: 29 })
    const path = versionCheckCachePath(h.opts.cacheDir as string)
    expect(h.stderr.join('')).toBe(
      `error: pvault 1.2.1 has been withdrawn by vault.example.com: ${REASON} (last confirmed 2026-09-24T10:00:00.000Z; the server is currently unreachable — if you trust this is wrong, delete ${path})\nDownload a supported release from ${RELEASES}\n`
    )
  })

  it('a sticky verdict for one server never leaks into another', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1' })
    await runVersionCheck(h.opts)
    h.fetchFn.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    h.opts.baseUrl = 'https://other.example.com'
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
  })

  it('upgrading the CLI clears the sticky verdict', async () => {
    const h = harness(withdrawnPolicy, { cliVersion: '1.2.1' })
    await runVersionCheck(h.opts)
    h.fetchFn.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    h.opts.cliVersion = '1.3.0'
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
  })

  it('never-checked + unreachable proceeds silently', async () => {
    const h = harness(() => Promise.reject(new TypeError('fetch failed')), { cliVersion: '1.2.1' })
    expect(await runVersionCheck(h.opts)).toEqual({ refuse: false })
    expect(h.stderr).toEqual([])
  })

  it('sanitizes the printed host', async () => {
    const h = harness(withdrawnPolicy, {
      cliVersion: '1.2.1',
      baseUrl: 'https://xn--vault-ex-7ya.example.com/',
    })
    await runVersionCheck(h.opts)
    expect(h.stderr[0]).toContain('withdrawn by xn--vault-ex-7ya.example.com:')
  })
})
