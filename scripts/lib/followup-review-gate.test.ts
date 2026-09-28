import { describe, expect, it } from 'vitest'
import { isTrackedInDeferredWork } from './followup-review-gate.js'

const KEY = '22-1-some-story'

describe('isTrackedInDeferredWork (Story 22.7 helper; tests added by Story 43.12)', () => {
  it('matches a source_spec naming <key>.md, with or without backticks', () => {
    expect(isTrackedInDeferredWork(KEY, `source_spec: \`${KEY}.md\` (review)`)).toBe(true)
    expect(isTrackedInDeferredWork(KEY, `source_spec: ${KEY}.md`)).toBe(true)
  })

  it('matches the key as a full token in a ### DW- heading', () => {
    expect(isTrackedInDeferredWork(KEY, `### DW-9: ${KEY} review follow-ups\n`)).toBe(true)
  })

  it('does not let a near-miss key satisfy another (22-1 vs 22-10)', () => {
    const near = '22-10-some-story'
    const ledger = `### DW-9: ${near} follow-ups\nsource_spec: \`${near}.md\`\n`
    expect(isTrackedInDeferredWork('22-1-some-story', ledger)).toBe(false)
    expect(isTrackedInDeferredWork('22-1', `### DW-9: 22-10 follow-ups\n`)).toBe(false)
    expect(isTrackedInDeferredWork('22-1', `### DW-9: 22-1 follow-ups\n`)).toBe(true)
  })

  it('ignores a key mentioned only in body prose', () => {
    expect(isTrackedInDeferredWork(KEY, `### DW-9: other\nreason: see ${KEY}\n`)).toBe(false)
  })

  it('accepts a spec-<key>.md source_spec only when asked (Story 43.12 AC-2 rule 1)', () => {
    const ledger = `### DW-9: other\nsource_spec: \`spec-${KEY}.md\`\n`
    expect(isTrackedInDeferredWork(KEY, ledger)).toBe(false)
    expect(isTrackedInDeferredWork(KEY, ledger, { allowSpecPrefix: true })).toBe(true)
  })
})
