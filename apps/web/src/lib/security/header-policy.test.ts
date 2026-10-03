// Story 68.6 AC-5/AC-6 — PV's security headers as one composable, validated, frozen data policy.
import { describe, expect, it } from 'vitest'
import {
  PV_HEADER_POLICY,
  composeHeaderPolicy,
  describeHeaderPolicyDelta,
  resolveHeaders,
  validateHeaderPolicy,
  type HeaderPolicy,
  type HeaderRule,
} from './header-policy.js'
import { getFrameProtectionHeaders, getHandoffSecurityHeaders } from './hardening.js'

const req = (pathname: string, routeId: string | null = null) => ({ pathname, routeId })

function withRules(...rules: HeaderRule[]): HeaderPolicy {
  return { ...PV_HEADER_POLICY, rules: [...PV_HEADER_POLICY.rules, ...rules] }
}

describe('PV_HEADER_POLICY (AC-5)', () => {
  it('defaults are the frame-protection headers and the only rule is the exact /handoff rule', () => {
    expect(PV_HEADER_POLICY.defaults).toEqual(getFrameProtectionHeaders())
    expect(PV_HEADER_POLICY.rules.map((r) => r.id)).toEqual(['handoff'])
    expect(PV_HEADER_POLICY.rules[0]?.match).toEqual({ exact: '/handoff' })
    expect(PV_HEADER_POLICY.rules[0]?.headers).toEqual(getHandoffSecurityHeaders())
  })

  it('first matching rule replaces the defaults; otherwise defaults (exact match only)', () => {
    expect(resolveHeaders(PV_HEADER_POLICY, req('/handoff'))).toEqual(getHandoffSecurityHeaders())
    for (const path of ['/handoff/x', '/handoff-admin', '/dashboard', '/extensions/panels']) {
      expect(resolveHeaders(PV_HEADER_POLICY, req(path))).toEqual(getFrameProtectionHeaders())
    }
  })

  it('returns a fresh object per call (a caller cannot mutate the shared policy)', () => {
    const a = resolveHeaders(PV_HEADER_POLICY, req('/x'))
    a['x-frame-options'] = 'SAMEORIGIN'
    expect(resolveHeaders(PV_HEADER_POLICY, req('/x'))['x-frame-options']).toBe('DENY')
  })

  it('is deep-frozen: a strict-mode write throws', () => {
    expect(() => {
      ;(PV_HEADER_POLICY.defaults as Record<string, string>)['x-frame-options'] = 'x'
    }).toThrow(TypeError)
    expect(() => {
      ;(PV_HEADER_POLICY.rules as HeaderRule[]).push(PV_HEADER_POLICY.rules[0] as HeaderRule)
    }).toThrow(TypeError)
    expect(Object.isFrozen(PV_HEADER_POLICY.rules[0]?.headers)).toBe(true)
  })

  it('matchers: exact, raw startsWith, routeId and a test predicate', () => {
    const policy = withRules(
      { id: 'sw', match: { startsWith: '/a/' }, headers: { 'x-a': 'sw' } },
      { id: 'rid', match: { routeId: '/(app)/b' }, headers: { 'x-a': 'rid' } },
      { id: 'pred', match: { test: ({ pathname }) => pathname === '/c' }, headers: { 'x-a': 'p' } }
    )
    const validated = validateHeaderPolicy(policy)
    expect(resolveHeaders(validated, req('/a/1'))).toEqual({ 'x-a': 'sw' })
    expect(resolveHeaders(validated, req('/a'))).toEqual(getFrameProtectionHeaders())
    expect(resolveHeaders(validated, req('/b', '/(app)/b'))).toEqual({ 'x-a': 'rid' })
    expect(resolveHeaders(validated, req('/b'))).toEqual(getFrameProtectionHeaders())
    expect(resolveHeaders(validated, req('/c'))).toEqual({ 'x-a': 'p' })
  })
})

describe('validateHeaderPolicy — integrity only (AC-5)', () => {
  const bad: Array<[string, HeaderPolicy, RegExp]> = [
    [
      'case-duplicate names',
      { ...PV_HEADER_POLICY, defaults: { 'X-A': '1', 'x-a': '2' } },
      /defaults: header "x-a" is set twice/,
    ],
    [
      'set-cookie',
      { ...PV_HEADER_POLICY, defaults: { 'Set-Cookie': 'a=1' } },
      /defaults: "Set-Cookie" cannot be set through the header policy/,
    ],
    [
      'duplicate rule ids',
      withRules({ id: 'handoff', match: { exact: '/y' }, headers: { 'x-a': '1' } }),
      /rule "handoff" is defined twice/,
    ],
    [
      'empty value',
      withRules({ id: 'e', match: { exact: '/y' }, headers: { 'x-a': '' } }),
      /rule "e": header "x-a" must be a non-empty string/,
    ],
    [
      'non-string value',
      withRules({ id: 'n', match: { exact: '/y' }, headers: { 'x-a': 1 as unknown as string } }),
      /rule "n": header "x-a" must be a non-empty string/,
    ],
    [
      'CR/LF in a value',
      withRules({ id: 'crlf', match: { exact: '/y' }, headers: { 'x-a': 'a\r\nx-b: 1' } }),
      /rule "crlf": header "x-a" value contains CR, LF or NUL/,
    ],
    [
      'NUL in a value',
      withRules({ id: 'nul', match: { exact: '/y' }, headers: { 'x-a': 'a\u0000' } }),
      /rule "nul": header "x-a" value contains CR, LF or NUL/,
    ],
    [
      // Code review 68-6: undici's Headers rejects a value above U+00FF (ByteString) when Kit
      // applies the headers, so every response under the policy would be a 500.
      'a character above U+00FF in a value',
      withRules({ id: 'quote', match: { exact: '/y' }, headers: { 'x-a': 'a’b' } }),
      /rule "quote": header "x-a" value contains a character not allowed in a header value/,
    ],
    [
      // Node's http layer rejects other control characters (ERR_INVALID_CHAR) when it writes the
      // response, so every response under the policy would fail.
      'a control character in a value',
      withRules({ id: 'ctl', match: { exact: '/y' }, headers: { 'x-a': 'a\u0001b\u007f' } }),
      /rule "ctl": header "x-a" value contains a character not allowed in a header value/,
    ],
    [
      'non-token name',
      withRules({ id: 't', match: { exact: '/y' }, headers: { 'x a': '1' } }),
      /rule "t": "x a" is not a valid header name/,
    ],
    [
      'match with no key',
      withRules({ id: 'm0', match: {} as never, headers: { 'x-a': '1' } }),
      /rule "m0": match must have exactly one of exact, startsWith, routeId, test/,
    ],
    [
      'match with two keys',
      withRules({ id: 'm2', match: { exact: '/a', startsWith: '/b' } as never, headers: {} }),
      /rule "m2": match must have exactly one of exact, startsWith, routeId, test/,
    ],
    [
      'match of the wrong type',
      withRules({ id: 'mt', match: { exact: 1 } as never, headers: {} }),
      /rule "mt": match.exact must be a string/,
    ],
    [
      'empty rule id',
      withRules({ id: '', match: { exact: '/a' }, headers: {} }),
      /every rule needs a non-empty string id/,
    ],
  ]

  for (const [name, policy, message] of bad) {
    it(`fails fast on ${name}, naming the rule and header`, () => {
      expect(() => validateHeaderPolicy(policy)).toThrow(message)
    })
  }

  it('accepts any header name and value that is well-formed (no allowlist)', () => {
    expect(() =>
      validateHeaderPolicy(
        withRules({
          id: 'anything',
          match: { exact: '/z' },
          headers: {
            'x-totally-custom': 'v',
            'content-security-policy': 'default-src *',
            // HTAB and obs-text (U+0080-U+00FF) are valid field-value characters.
            'x-latin1': 'a\tb é',
          },
        })
      )
    ).not.toThrow()
  })
})

describe('composeHeaderPolicy — contributions add, change and remove (AC-6)', () => {
  it('no contribution: the PV policy itself', () => {
    expect(composeHeaderPolicy(PV_HEADER_POLICY, undefined)).toBe(PV_HEADER_POLICY)
  })

  it('add: a CM rule keyed on a route id carries its own headers; other routes unchanged', () => {
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      rules: [
        ...pv.rules,
        {
          id: 'cm-billing',
          match: { routeId: '/(app)/cm-area' },
          headers: { ...pv.defaults, 'permissions-policy': 'payment=(self)' },
        },
      ],
    }))
    expect(resolveHeaders(composed, req('/cm-area', '/(app)/cm-area'))).toEqual({
      ...getFrameProtectionHeaders(),
      'permissions-policy': 'payment=(self)',
    })
    expect(resolveHeaders(composed, req('/dashboard', '/(app)/dashboard'))).toEqual(
      getFrameProtectionHeaders()
    )
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed)).toEqual({
      added: ['rules.cm-billing'],
      changed: [],
      removed: [],
    })
  })

  it('change app-wide: every route without a rule gets it; /handoff keeps its own rule', () => {
    const csp = "frame-ancestors 'none'; img-src 'self' https://cdn.example"
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      defaults: { ...pv.defaults, 'content-security-policy': csp },
    }))
    expect(resolveHeaders(composed, req('/dashboard'))['content-security-policy']).toBe(csp)
    expect(
      resolveHeaders(composed, req('/cm-page', '/(cm)/cm-page'))['content-security-policy']
    ).toBe(csp)
    expect(resolveHeaders(composed, req('/handoff'))).toEqual(getHandoffSecurityHeaders())
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed).changed).toEqual([
      'defaults.content-security-policy',
    ])
  })

  it('remove: deleting x-frame-options is allowed and recorded, never refused', () => {
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      defaults: { 'content-security-policy': pv.defaults['content-security-policy'] as string },
    }))
    expect(resolveHeaders(composed, req('/dashboard'))).not.toHaveProperty('x-frame-options')
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed).removed).toEqual([
      'defaults.x-frame-options',
    ])
  })

  it('may remove every PV header and every rule (anti-allowlist, recorded)', () => {
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      defaults: {},
      rules: [],
    }))
    expect(resolveHeaders(composed, req('/handoff'))).toEqual({})
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed).removed).toEqual([
      'defaults.content-security-policy',
      'defaults.x-frame-options',
      'rules.handoff',
    ])
  })

  it('records header-level and match changes inside an existing rule, and opaque predicates', () => {
    const predicate = () => true
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv): HeaderPolicy => ({
      ...pv,
      rules: [
        {
          id: 'handoff',
          match: { startsWith: '/handoff' },
          headers: {
            ...getHandoffSecurityHeaders(),
            'referrer-policy': 'no-referrer',
            'x-new': '1',
          },
        },
        { id: 'pred', match: { test: predicate }, headers: { 'x-a': '1' } },
      ],
    }))
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed)).toEqual({
      added: ['rules.handoff.x-new', 'rules.pred (opaque match)'],
      changed: ['rules.handoff.match', 'rules.handoff.referrer-policy'],
      removed: [],
    })
  })

  it('identity contribution: allowed, delta empty', () => {
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => pv)
    expect(describeHeaderPolicyDelta(PV_HEADER_POLICY, composed)).toEqual({
      added: [],
      changed: [],
      removed: [],
    })
  })

  it('a throwing contribution fails with the thrown error (no fallback to PV policy)', () => {
    const boom = new Error('cm policy broke')
    expect(() =>
      composeHeaderPolicy(PV_HEADER_POLICY, () => {
        throw boom
      })
    ).toThrow(boom)
  })

  it('a non-function headerPolicy export fails with the shape message', () => {
    expect(() => composeHeaderPolicy(PV_HEADER_POLICY, 'nope' as never)).toThrow(
      'hooks.server: export "headerPolicy" must be a function (pv: HeaderPolicy) => HeaderPolicy (got string)'
    )
  })

  it('validates the composed policy and deep-freezes it', () => {
    expect(() =>
      composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({ ...pv, defaults: { 'x a': '1' } }))
    ).toThrow(/defaults: "x a" is not a valid header name/)
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      defaults: { ...pv.defaults },
    }))
    expect(Object.isFrozen(composed.defaults)).toBe(true)
  })
})

describe('route-level setHeaders conflict (Q2, AC-6)', () => {
  it('fails at boot when the policy would set a header a route load also sets', () => {
    expect(() =>
      composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
        ...pv,
        defaults: { ...pv.defaults, 'referrer-policy': 'same-origin' },
      }))
    ).toThrow(
      'header policy sets "referrer-policy" on /shares/… and /external-shares/…, which their load also sets with event.setHeaders (SvelteKit would throw "already set" there): exclude those paths in your rule or override those pages'
    )
  })

  it('a rule excluding those paths boots, and the share pages keep their own header', () => {
    const composed = composeHeaderPolicy(PV_HEADER_POLICY, (pv) => ({
      ...pv,
      rules: [
        ...pv.rules,
        { id: 'shares', match: { startsWith: '/shares/' }, headers: { ...pv.defaults } },
        {
          id: 'ext-shares',
          match: { startsWith: '/external-shares/' },
          headers: { ...pv.defaults },
        },
      ],
      defaults: { ...pv.defaults, 'referrer-policy': 'same-origin' },
    }))
    expect(
      resolveHeaders(composed, req('/shares/tok', '/(app)/shares/[token]'))
    ).not.toHaveProperty('referrer-policy')
    expect(resolveHeaders(composed, req('/dashboard'))['referrer-policy']).toBe('same-origin')
  })

  it('PV_HEADER_POLICY.routeSetHeaders lists every setHeaders( call under src/routes', () => {
    const sources: Record<string, string> = import.meta.glob(
      ['/src/routes/**/*.ts', '/src/routes/**/*.svelte', '!/src/routes/**/*.test.ts'],
      { query: '?raw', import: 'default', eager: true }
    )
    const found: Array<{ routeId: string; names: string[] }> = []
    for (const [file, source] of Object.entries(sources)) {
      const calls = [...source.matchAll(/setHeaders\(\{([^}]*)\}\)/g)]
      // Every setHeaders( call must be the literal-object form this scan can read.
      expect(source.split('setHeaders(').length - 1, file).toBe(calls.length)
      const routeId = file.replace(/^\/src\/routes/, '').replace(/\/[^/]+$/, '') || '/'
      for (const call of calls) {
        const names = [...(call[1] ?? '').matchAll(/'([^']+)'\s*:/g)].map((m) =>
          (m[1] ?? '').toLowerCase()
        )
        found.push({ routeId, names })
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(2)
    const byRoute = (a: { routeId: string }, b: { routeId: string }) =>
      a.routeId < b.routeId ? -1 : Number(a.routeId > b.routeId)
    const listed = PV_HEADER_POLICY.routeSetHeaders.map((r) => ({
      routeId: r.routeId,
      names: [...r.names],
    }))
    expect(found.sort(byRoute)).toEqual(listed.sort(byRoute))
  })
})

describe('invariant 0 and anti-allowlist (AC-6, AC-11)', () => {
  it('header-policy.ts has no matcher keyed on CM provenance and no allowlist-shaped code', () => {
    const source = import.meta.glob('./header-policy.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    })['./header-policy.ts'] as string
    expect(source).not.toMatch(/_cm|\$cm|composition\.lock|isComposed/)
    expect(source).not.toMatch(
      /allowedHeaders|ALLOWED_HEADERS|ALLOWED_PATHS|permittedPaths|headerWhitelist|HEADER_WHITELIST/
    )
  })
})
