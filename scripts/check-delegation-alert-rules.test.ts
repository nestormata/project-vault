import { describe, expect, it, vi } from 'vitest'

// The two constants this guard imports live in modules that load the API config. The real config
// needs database URLs; only the closed outcome set and the metric name are read here.
vi.mock('../apps/api/src/config/env.js', () => ({
  env: {},
  delegationVerifyKeys: [],
}))

import {
  DELEGATION_OUTCOMES,
  DELEGATION_REASON_TO_OUTCOME,
  DELEGATION_REJECT_REASONS,
  isPreSignatureRejection,
} from '../apps/api/src/modules/auth/delegation-verify.js'
import { DELEGATION_ASSERTIONS_METRIC_NAME } from '../apps/api/src/modules/auth/delegation-metrics.js'

// Story 71.9 AC-3 / AC-6: the delegation alert rules are a versioned artifact with no Prometheus in
// the repo to load them, so this guard is what keeps them honest: the file parses, every rule is
// complete, every `outcome` literal is a real member of the closed counter set, the metric name is
// the real one, every `runbook_url` anchor is a heading of the runbook, and the docs name every
// outcome and every alert. `promtool check rules` is the authoritative syntax check (not run in CI:
// no promtool in the `make ci` image); this guard is structural.
//
// Loaded as raw text by Vite (the lint-clean pattern of extension-authoring-docs.test.ts: no
// non-literal fs paths). YAML: no parser dependency is available to `scripts/`, so a minimal parser
// for the subset the rules file uses lives here and throws on any shape it does not understand.
const LIVE_FILES: Record<string, string> = import.meta.glob(
  [
    '../docs/runbooks/alerts/delegation-alerts.rules.yml',
    '../docs/runbooks/delegation-key-rotation.md',
    '../docs/runbooks/monitoring.md',
    '../docs/runbooks/README.md',
    '../docs/runbook.md',
    '../Makefile',
    '../.github/workflows/ci.yml',
  ],
  { query: '?raw', import: 'default', eager: true }
)

const RULES_PATH = '../docs/runbooks/alerts/delegation-alerts.rules.yml'
const RUNBOOK_PATH = '../docs/runbooks/delegation-key-rotation.md'
const MONITORING_PATH = '../docs/runbooks/monitoring.md'
const README_PATH = '../docs/runbooks/README.md'
const RUNBOOK_INDEX_PATH = '../docs/runbook.md'
const MAKEFILE_PATH = '../Makefile'
const CI_WORKFLOW_PATH = '../.github/workflows/ci.yml'
const GUARD_TEST_PATH = 'scripts/check-delegation-alert-rules.test.ts'
const RUNBOOK_URL_PATH = 'docs/runbooks/delegation-key-rotation.md'
const SHIPPED_ALERTS = [
  'PvDelegationSignatureInvalidSpike',
  'PvDelegationUnknownKidSpike',
  'PvDelegationReplayed',
  'PvDelegationStoreUnavailable',
  'PvDelegationClockSkew',
  'PvDelegationRejectionRatioHigh',
  'PvDelegationKeyConfigMissing',
]
// Outcomes counted before any request-level signature check, or controllable without a key.
const HOST_PRE_SIGNATURE_OUTCOMES = ['missing', 'rate_limited_pre']
const ADMITTED_ONLY_OUTCOMES = ['actor_unlinked', 'actor_attested_nonmember']

function liveFile(path: string): string {
  const text = new Map(Object.entries(LIVE_FILES)).get(path)
  if (typeof text !== 'string') throw new Error(`${path} is not loaded: the guard cannot run`)
  return text
}

type YamlNode = string | YamlNode[] | { [key: string]: YamlNode }
type Line = { indent: number; text: string }

const BLOCK_SCALAR_MARKERS: ReadonlySet<string> = new Set(['|', '>', '|-', '>-'])

function toLines(text: string): Line[] {
  return text
    .split('\n')
    .filter((raw) => raw.trim() !== '' && !raw.trim().startsWith('#'))
    .map((raw) => {
      if (/^\s*\t/.test(raw)) throw new Error(`tab indentation is not supported: ${raw}`)
      return { indent: raw.length - raw.trimStart().length, text: raw.trim() }
    })
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  return quoted ? (quoted[2] ?? '') : value
}

const NAME_PATTERN = /^[A-Za-z_][\w-]*$/

function splitNameValue(text: string): { name: string; value: string } | undefined {
  const colon = text.indexOf(':')
  if (colon < 1) return undefined
  const name = text.slice(0, colon)
  const rest = text.slice(colon + 1)
  if (!NAME_PATTERN.test(name) || (rest !== '' && !rest.startsWith(' '))) return undefined
  return { name, value: rest.trim() }
}

/** A minimal YAML subset parser: block mappings, block sequences, plain/quoted scalars, `|` / `>` blocks. */
export function parseYamlSubset(text: string): YamlNode {
  const lines = toLines(text)
  let cursor = 0
  const peek = (): Line | undefined => lines.at(cursor)

  function parseBlockScalar(parentIndent: number, folded: boolean): string {
    const collected: string[] = []
    for (let line = peek(); line !== undefined && line.indent > parentIndent; line = peek()) {
      collected.push(line.text)
      cursor += 1
    }
    return collected.join(folded ? ' ' : '\n')
  }

  function parseMapping(indent: number): { [name: string]: YamlNode } {
    const result = new Map<string, YamlNode>()
    for (let line = peek(); line?.indent === indent && !line.text.startsWith('- '); line = peek()) {
      const pair = splitNameValue(line.text)
      if (!pair) throw new Error(`cannot parse line: ${line.text}`)
      cursor += 1
      if (BLOCK_SCALAR_MARKERS.has(pair.value)) {
        result.set(pair.name, parseBlockScalar(indent, pair.value.startsWith('>')))
      } else if (pair.value === '') {
        const next = peek()
        result.set(pair.name, next && next.indent > indent ? parseBlock(next.indent) : '')
      } else {
        result.set(pair.name, unquote(pair.value))
      }
    }
    return Object.fromEntries(result)
  }

  function parseSequence(indent: number): YamlNode[] {
    const items: YamlNode[] = []
    for (let line = peek(); line?.indent === indent && line.text.startsWith('- '); line = peek()) {
      const content = line.text.slice(2).trim()
      if (splitNameValue(content)) {
        // `- name: value` opens a mapping whose first entry sits two columns to the right.
        lines.splice(cursor, 1, { indent: indent + 2, text: content })
        items.push(parseMapping(indent + 2))
      } else {
        cursor += 1
        items.push(unquote(content))
      }
    }
    return items
  }

  function parseBlock(indent: number): YamlNode {
    return peek()?.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent)
  }

  if (lines.length === 0) throw new Error('the YAML text is empty')
  const root = parseBlock(peek()?.indent ?? 0)
  if (cursor !== lines.length) throw new Error(`unparsed content from: ${peek()?.text}`)
  return root
}

export type AlertRule = {
  alert: string
  expr: string
  for?: string
  labels: { severity?: string }
  annotations: { summary?: string; runbook_url?: string }
}

function asRecord(node: YamlNode | undefined): { [key: string]: YamlNode } {
  if (typeof node !== 'object' || Array.isArray(node) || node === null) return {}
  return node
}

function asText(node: YamlNode | undefined): string | undefined {
  return typeof node === 'string' ? node : undefined
}

/** Every rule of every group. Throws when nothing parses, so the guard cannot pass vacuously. */
export function extractRules(yamlText: string): AlertRule[] {
  const groups = asRecord(parseYamlSubset(yamlText))['groups']
  if (!Array.isArray(groups) || groups.length === 0)
    throw new Error('no `groups` in the rules file')
  const rules = groups.flatMap((group) => {
    const list = asRecord(group)['rules']
    return Array.isArray(list) ? list : []
  })
  if (rules.length === 0) throw new Error('the rules file declares no rule')
  return rules.map((node) => {
    const rule = asRecord(node)
    const labels = asRecord(rule['labels'])
    const annotations = asRecord(rule['annotations'])
    return {
      alert: asText(rule['alert']) ?? '',
      expr: asText(rule['expr']) ?? '',
      for: asText(rule['for']),
      labels: { severity: asText(labels['severity']) },
      annotations: {
        summary: asText(annotations['summary']),
        runbook_url: asText(annotations['runbook_url']),
      },
    }
  })
}

const OUTCOME_MATCHER = /\boutcome\s*(=~|!~|!=|=)\s*"([^"]*)"/g

export type OutcomeMatcher = { operator: string; outcomes: string[] }

export function outcomeMatchers(expr: string): OutcomeMatcher[] {
  return [...expr.matchAll(OUTCOME_MATCHER)].map((match) => ({
    operator: match[1] ?? '',
    outcomes: (match[2] ?? '').split('|'),
  }))
}

/** The metric selectors of an expression: the identifier before every `{`. */
export function metricNames(expr: string): string[] {
  return [...expr.matchAll(/([A-Za-z_:][A-Za-z0-9_:]*)\s*\{/g)].map((match) => match[1] ?? '')
}

export function headingAnchors(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9 _-]/g, '')
        .replace(/ /g, '-')
    )
}

function runbookAnchor(url: string | undefined): string | undefined {
  const marker = `${RUNBOOK_URL_PATH}#`
  const at = (url ?? '').indexOf(marker)
  return at === -1 ? undefined : (url ?? '').slice(at + marker.length)
}

const PRE_SIGNATURE_OUTCOMES: string[] = [
  ...new Set([
    ...Object.entries(DELEGATION_REASON_TO_OUTCOME)
      .filter(([reason]) =>
        isPreSignatureRejection(reason as (typeof DELEGATION_REJECT_REASONS)[number])
      )
      .map(([, outcome]) => outcome),
    ...HOST_PRE_SIGNATURE_OUTCOMES,
  ]),
]

const rules = extractRules(liveFile(RULES_PATH))
const runbook = liveFile(RUNBOOK_PATH)

describe('the shipped delegation alert rules (Story 71.9 AC-3)', () => {
  it('ships exactly the agreed rules, so deleting one fails', () => {
    expect(rules.map((rule) => rule.alert).sort()).toEqual([...SHIPPED_ALERTS].sort())
  })

  it('gives every rule an expression, a for, a severity, a summary and a runbook_url', () => {
    for (const rule of rules) {
      expect(rule.alert, 'alert').toMatch(/^PvDelegation[A-Za-z]+$/)
      expect(rule.expr.trim(), `${rule.alert} expr`).not.toBe('')
      expect(rule.for, `${rule.alert} for`).toMatch(/^\d+[smh]$/)
      expect(['warning', 'critical'], `${rule.alert} severity`).toContain(rule.labels.severity)
      expect(rule.annotations.summary?.length ?? 0, `${rule.alert} summary`).toBeGreaterThan(10)
      expect(rule.annotations.runbook_url, `${rule.alert} runbook_url`).toMatch(/^https:\/\//)
    }
  })

  it('names only real outcomes of the closed counter set (a renamed outcome fails)', () => {
    for (const rule of rules) {
      const matchers = outcomeMatchers(rule.expr)
      expect(matchers.length, `${rule.alert} selects an outcome`).toBeGreaterThan(0)
      for (const { outcomes } of matchers) {
        for (const outcome of outcomes) {
          expect(DELEGATION_OUTCOMES, `${rule.alert} outcome "${outcome}"`).toContain(outcome)
        }
      }
    }
  })

  it('selects only the real metric name', () => {
    for (const rule of rules) {
      const names = metricNames(rule.expr)
      expect(names.length, `${rule.alert} selects a metric`).toBeGreaterThan(0)
      for (const name of names) expect(name).toBe(DELEGATION_ASSERTIONS_METRIC_NAME)
    }
  })

  it('never uses the kid label, and aggregates only across scrape targets', () => {
    for (const rule of rules) {
      expect(rule.expr, `${rule.alert} must not use kid`).not.toMatch(/\bkid\b/)
      expect(rule.expr, `${rule.alert} must not group by an attacker-chosen label`).not.toMatch(
        /\b(by|without)\s*\(/
      )
    }
  })

  it('points every runbook_url at an existing heading of the runbook', () => {
    const anchors = headingAnchors(runbook)
    for (const rule of rules) {
      const anchor = runbookAnchor(rule.annotations.runbook_url)
      expect(anchor, `${rule.alert} links ${RUNBOOK_URL_PATH}#...`).toBeDefined()
      expect(anchors, `${rule.alert} anchor`).toContain(anchor)
    }
  })

  it('computes the rejection ratio over post-signature outcomes only, derived from isPreSignatureRejection', () => {
    const ratio = rules.find((rule) => rule.alert === 'PvDelegationRejectionRatioHigh')
    expect(ratio).toBeDefined()
    const exclusions = outcomeMatchers(ratio?.expr ?? '').filter(
      ({ operator }) => operator === '!~'
    )
    expect(exclusions.length).toBeGreaterThanOrEqual(2)
    const denominator = [...PRE_SIGNATURE_OUTCOMES, ...ADMITTED_ONLY_OUTCOMES].sort()
    const numerator = [...denominator, 'accepted'].sort()
    const seen = new Set(exclusions.map(({ outcomes }) => [...outcomes].sort().join('|')))
    expect(seen).toEqual(new Set([numerator.join('|'), denominator.join('|')]))
    // The pre-signature list is the verifier's, not a hand-copied one.
    expect(PRE_SIGNATURE_OUTCOMES.length).toBeGreaterThanOrEqual(8)
    for (const outcome of PRE_SIGNATURE_OUTCOMES) expect(DELEGATION_OUTCOMES).toContain(outcome)
  })
})

describe('the guard cannot pass vacuously and catches drift (Story 71.9 AC-3)', () => {
  it('throws on an empty or rule-less file', () => {
    expect(() => extractRules('')).toThrow()
    expect(() => extractRules('# only a comment\n')).toThrow()
    expect(() => extractRules('groups:\n  - name: empty\n    rules: []\n')).toThrow()
  })

  it('reports a renamed outcome literal', () => {
    const mutated = liveFile(RULES_PATH).replace('outcome="replayed"', 'outcome="replay"')
    const [replayed] = extractRules(mutated).filter((rule) => rule.alert === 'PvDelegationReplayed')
    const unknown = outcomeMatchers(replayed?.expr ?? '')
      .flatMap(({ outcomes }) => outcomes)
      .filter((outcome) => !DELEGATION_OUTCOMES.includes(outcome))
    expect(unknown).toEqual(['replay'])
  })

  it('reports a wrong metric name and a dangling runbook anchor', () => {
    const wrongMetric = liveFile(RULES_PATH).replace(
      /pv_delegation_assertions_total/g,
      'pv_delegation_assertion_total'
    )
    expect(metricNames(extractRules(wrongMetric)[0]?.expr ?? '')).not.toContain(
      DELEGATION_ASSERTIONS_METRIC_NAME
    )
    expect(headingAnchors(runbook)).not.toContain('a-heading-that-does-not-exist')
  })
})

describe('the docs name every outcome and every alert (Story 71.9 AC-6)', () => {
  it('lists every closed outcome in the monitoring.md metric-table row', () => {
    const row = liveFile(MONITORING_PATH)
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(DELEGATION_ASSERTIONS_METRIC_NAME))
    expect(row, 'a monitoring.md table row for the counter').toBeDefined()
    for (const outcome of DELEGATION_OUTCOMES) expect(row).toContain(`\`${outcome}\``)
  })

  it('mentions every shipped alert in the runbook and in monitoring.md', () => {
    const monitoring = liveFile(MONITORING_PATH)
    for (const alert of SHIPPED_ALERTS) {
      expect(runbook, `runbook mentions ${alert}`).toContain(alert)
      expect(monitoring, `monitoring.md mentions ${alert}`).toContain(alert)
    }
  })

  it('wires the runbook into the runbook index and the README trigger table', () => {
    expect(liveFile(README_PATH)).toContain('delegation-key-rotation.md')
    expect(liveFile(RUNBOOK_INDEX_PATH)).toContain('delegation-key-rotation.md')
  })
})

describe('the guard is wired into CI (Story 71.9 self-wiring)', () => {
  it('runs from the Makefile ci-inner target and from the public CI workflow', () => {
    expect(liveFile(MAKEFILE_PATH)).toContain(GUARD_TEST_PATH)
    expect(liveFile(CI_WORKFLOW_PATH)).toContain(GUARD_TEST_PATH)
  })
})
