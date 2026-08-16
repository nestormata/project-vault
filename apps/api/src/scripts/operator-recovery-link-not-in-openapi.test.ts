import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

/**
 * Story 23.2 AC-8a item 2: "It is host-only by construction: it is a CLI entry point, reachable
 * only by someone who can already execute in the API container/host. There is no route, no admin
 * setting, and no org setting that invokes it. Dedicated test asserting the OpenAPI spec
 * references nothing of the kind."
 */
describe('operator:recovery-link break-glass CLI is not reachable via any route (AC-8a item 2)', () => {
  it('is absent from the live OpenAPI spec entirely', async () => {
    const app = await createApp({ logger: false })
    await app.ready()
    const spec = JSON.stringify(app.swagger())
    await app.close()

    // Deliberately narrow: the codebase already has an unrelated, legitimate "break-glass"
    // rotation feature (apps/api/src/modules/rotation/*) with its own routes — a bare
    // /break-glass/ match would false-positive on that. This asserts specifically that nothing
    // referencing the AC-8a operator:recovery-link CLI leaked into the spec.
    expect(spec).not.toMatch(/recovery-link/i)
    expect(spec).not.toMatch(/operator:recovery/i)
    expect(spec).not.toMatch(/native_login\.break_glass_recovery_minted/i)
  })
})
