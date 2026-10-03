// Story 68.6 AC-6 (Elicitation 3) — every module-init failure of the composition (header policy
// validation, route setHeaders conflict, hook shape errors, transport collisions, redirect loops)
// would otherwise surface as a crash-looping production server. This test runs the same
// compositions over whatever the three virtual modules contain: trivially green in PV's own run
// (empty contributions), and in a composed tree's test run (68-9) it fails CM's CI first with the
// same message the server would print.
import { describe, expect, it } from 'vitest'
import { hooks as server, protectedPaths } from 'virtual:pv-hooks/server'
import { hooks as universal } from 'virtual:pv-hooks/universal'
import { hooks as client } from 'virtual:pv-hooks/client'
import { PV_HEADER_POLICY, composeHeaderPolicy } from '$lib/security/header-policy.js'
import { composeUniversalHooks } from './compose-universal-hooks.js'
import { composeClientHooks } from './compose-client-hooks.js'
import { composeChainHook, readHandleContribution } from './hook-chain.js'
import { HOOK_SURFACE } from './hook-surface.js'

describe('composed hooks initialise (AC-6)', () => {
  it('server contribution: header policy, handle shape and every chain hook compose', () => {
    expect(() => composeHeaderPolicy(PV_HEADER_POLICY, server.headerPolicy as never)).not.toThrow()
    expect(() => readHandleContribution(server.handle)).not.toThrow()
    for (const name of HOOK_SURFACE.server.filter((hook) => hook !== 'handle')) {
      expect(() =>
        composeChainHook('server', name, undefined, new Map(Object.entries(server)).get(name))
      ).not.toThrow()
    }
    expect(Array.isArray(protectedPaths.routeIds)).toBe(true)
  })

  it('universal and client contributions compose', () => {
    expect(() => composeUniversalHooks({}, universal)).not.toThrow()
    expect(() => composeClientHooks({}, client)).not.toThrow()
  })
})
