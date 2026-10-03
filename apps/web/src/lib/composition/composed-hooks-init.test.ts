// Story 68.6 AC-6 (Elicitation 3) — every module-init failure of the composition (header policy
// validation, route setHeaders conflict, hook shape errors and a `handle.wrap` that returns no
// function, transport collisions, protected-path redirect loops) would otherwise surface as a
// crash-looping production server. This test runs the same compositions over whatever the three
// virtual modules contain (`checkComposedHooks`): trivially green in PV's own run (empty
// contributions), and in a composed tree's test run (68-9) it fails CM's CI first with the same
// message the server would print.
//
// Q3 (code review 68-6): it also prints every difference between the composed header policy and
// PV's, one `pv-compose: header policy: ...` line each (recorded, never refused), so a CM header
// change appears in the composed tree's test output. Nothing is printed for PV's own policy.
import { describe, expect, it } from 'vitest'
import { hooks as server, protectedPaths } from 'virtual:pv-hooks/server'
import { hooks as universal } from 'virtual:pv-hooks/universal'
import { hooks as client } from 'virtual:pv-hooks/client'
import { checkComposedHooks } from '$lib/server/composition/composed-hooks-check.js'

describe('composed hooks initialise (AC-6)', () => {
  it('server, protected-path, universal and client contributions compose', () => {
    const { notes } = checkComposedHooks({ server, protectedPaths, universal, client })
    for (const note of notes) process.stdout.write(`pv-compose: ${note}\n`)
    if (server.headerPolicy === undefined) expect(notes).toEqual([])
  })
})
