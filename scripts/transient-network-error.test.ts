import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Story 68.29 (DW-506, Story 68.10 AC-2.10): the bounded retry covers ONLY transient registry /
 * image-pull failures. The signature helper is shared by e2e-stack.sh and the consumer fixture.
 */

function classify(output: string): boolean {
  const run = spawnSync(
    'bash',
    [
      '-c',
      'source scripts/lib/transient-network-error.sh && is_transient_network_error <(printf %s "$OUTPUT")',
    ],
    { env: { ...process.env, OUTPUT: output } }
  )
  return run.status === 0
}

describe('is_transient_network_error', () => {
  it.each([
    'failed to solve: node:24: failed to resolve source metadata for docker.io/library/node:24: net/http: TLS handshake timeout',
    'Get "https://registry-1.docker.io/v2/": dial tcp: i/o timeout',
    'npm error code ECONNRESET',
    'npm error code ETIMEDOUT',
    'npm error code EAI_AGAIN',
    'toomanyrequests: You have reached your pull rate limit',
    'read tcp 10.0.0.2:443: connection reset by peer',
    'error pulling image: unexpected EOF',
    'npm error 503 Service Unavailable - GET https://registry.npmjs.org/svelte',
    'Error response from daemon: received unexpected HTTP status: 502 Bad Gateway',
  ])('retries: %s', (output) => {
    expect(classify(output)).toBe(true)
  })

  it.each([
    'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"',
    'COPY failed: file not found in build context',
    'Bind for 0.0.0.0:3000 failed: port is already allocated',
    'npm error code EUSAGE',
    'Error: expected 1 to be 2 (Playwright assertion)',
    'svelte-check found 3 errors',
    '',
  ])('never retries: %s', (output) => {
    expect(classify(output)).toBe(false)
  })
})

describe('retry wiring', () => {
  const stack = readFileSync('scripts/e2e-stack.sh', 'utf8')
  const fixture = readFileSync('scripts/web-host-consumer-fixture/run.sh', 'utf8')

  it('both callers source the shared helper and retry exactly once', () => {
    for (const script of [stack, fixture]) {
      expect(script).toContain('transient-network-error.sh')
      expect(script).toContain('is_transient_network_error')
      expect(script.match(/retrying after transient network error/g)).toHaveLength(1)
    }
  })

  it('never retries the Playwright run', () => {
    expect(stack).not.toMatch(/retry[^\n]*playwright/i)
  })
})
