/* eslint-disable security/detect-non-literal-fs-filename -- reads only this repository's smoke script. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Docker smoke retry policy', () => {
  it('retries normal startup connection and transient empty-response failures', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/docker-smoke.sh'), 'utf8')

    expect(script).toMatch(/7\|52\|56/)
    expect(script).toMatch(/MAX_ATTEMPTS|DEADLINE_SECONDS/)
  })

  it('prints container diagnostics when the bounded health wait expires', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/docker-smoke.sh'), 'utf8')

    expect(script).toMatch(/docker compose ps/)
    expect(script).toMatch(/docker compose logs/)
    expect(script).toMatch(/health.*failed|failed.*health/i)
  })
})
