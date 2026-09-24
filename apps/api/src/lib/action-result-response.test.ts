import type { ActionResult } from '@project-vault/extension-api'
import { describe, expect, it } from 'vitest'
import { isValidActionResult, mapActionResultToResponse } from './action-result-response.js'

const DENIED_HTML = '<p>D</p>'
const REQUEST_DENIED = 'Request denied'
const SAMPLE_HTML = '<p>x</p>'
const SECRET_REASON = 'secret reason'

// Story 59.1 — `html` is optional on every `ActionResult` variant; a non-string `html` on any
// variant makes the whole result malformed.
const HTML_VALUE_KINDS: ReadonlyArray<[kind: string, value: unknown, valid: boolean]> = [
  ['string', SAMPLE_HTML, true],
  ['undefined', undefined, true],
  ['number', 42, false],
  ['null', null, false],
  ['object', {}, false],
  ['array', ['<p>'], false],
  ['boolean', true, false],
]

const BASE_BY_OUTCOME: Record<ActionResult['outcome'], Record<string, unknown>> = {
  ok: { outcome: 'ok' },
  validation_failed: { outcome: 'validation_failed', message: 'm' },
  denied: { outcome: 'denied' },
  conflict: { outcome: 'conflict', message: 'm' },
  error: { outcome: 'error' },
}

const VALIDATION_MATRIX = Object.entries(BASE_BY_OUTCOME).flatMap(([outcome, base]) =>
  HTML_VALUE_KINDS.map(
    ([kind, value, valid]) =>
      [outcome, kind, { ...base, ...(kind === 'undefined' ? {} : { html: value }) }, valid] as const
  )
)

describe('Story 59.1 AC2 — isValidActionResult html validation', () => {
  it.each(VALIDATION_MATRIX)(
    '%s with %s html (%j) → valid=%s',
    (_outcome, _kind, candidate, valid) => {
      expect(isValidActionResult(candidate)).toBe(valid)
    }
  )

  it.each([
    { outcome: 'denied', html: SAMPLE_HTML },
    { outcome: 'denied' },
    { outcome: 'conflict', message: 'm', html: SAMPLE_HTML },
    { outcome: 'error', html: SAMPLE_HTML },
    { outcome: 'error' },
    { outcome: 'validation_failed', message: 'm', html: SAMPLE_HTML },
    { outcome: 'ok', html: '' },
  ])('accepts %j', (candidate) => {
    expect(isValidActionResult(candidate)).toBe(true)
  })

  it.each([
    { outcome: 'denied', html: 42 },
    { outcome: 'conflict', html: null },
    { outcome: 'error', html: {} },
    { outcome: 'error', html: ['<p>'] },
    { outcome: 'validation_failed', message: 'm', html: true },
    { outcome: 'validation_failed', html: SAMPLE_HTML },
    { outcome: 'ok', html: 1 },
  ])('rejects %j', (candidate) => {
    expect(isValidActionResult(candidate)).toBe(false)
  })
})

describe('Story 59.1 AC3 — mapActionResultToResponse forwards html on every outcome', () => {
  it.each<[ActionResult, number, Record<string, unknown>]>([
    [
      { outcome: 'denied', html: DENIED_HTML, message: SECRET_REASON },
      403,
      { code: 'denied', message: REQUEST_DENIED, html: DENIED_HTML },
    ],
    [{ outcome: 'denied' }, 403, { code: 'denied', message: REQUEST_DENIED }],
    [
      { outcome: 'conflict', message: 'Already renamed', html: '<p>C</p>' },
      409,
      { code: 'conflict', message: 'Already renamed', html: '<p>C</p>' },
    ],
    [{ outcome: 'conflict' }, 409, { code: 'conflict', message: 'Conflict' }],
    [
      { outcome: 'error', html: '<p>E</p>' },
      500,
      { code: 'internal_error', message: 'Request failed', html: '<p>E</p>' },
    ],
    [{ outcome: 'error' }, 500, { code: 'internal_error', message: 'Request failed' }],
    [
      { outcome: 'validation_failed', message: 'Name is required', html: '<p>V</p>' },
      400,
      { code: 'validation_failed', message: 'Name is required', html: '<p>V</p>' },
    ],
    [{ outcome: 'ok', html: '<p>O</p>' }, 200, { html: '<p>O</p>' }],
    [{ outcome: 'denied', html: '' }, 403, { code: 'denied', message: REQUEST_DENIED, html: '' }],
  ])('%j → %i %j', (result, status, body) => {
    const response = mapActionResultToResponse(result)
    expect(response.status).toBe(status)
    expect(response.body).toStrictEqual(body)
  })

  it('omits the html key entirely when the result carries none', () => {
    for (const result of [
      { outcome: 'denied' },
      { outcome: 'conflict' },
      { outcome: 'error' },
      { outcome: 'validation_failed', message: 'm' },
    ] as ActionResult[]) {
      expect('html' in mapActionResultToResponse(result).body).toBe(false)
    }
  })

  it('never forwards the suppressed denied.message', () => {
    const { body } = mapActionResultToResponse({
      outcome: 'denied',
      message: SECRET_REASON,
      html: DENIED_HTML,
    })
    expect(JSON.stringify(body)).not.toContain(SECRET_REASON)
  })

  it('builds the body from explicit fields only: extra runtime keys never reach the wire', () => {
    const smuggled = {
      outcome: 'error',
      html: '<p>E</p>',
      stack: 'Error: at db.ts:12',
      detail: 'relation "x"',
    } as ActionResult
    const { status, body } = mapActionResultToResponse(smuggled)
    expect(status).toBe(500)
    expect(Object.keys(body).sort()).toEqual(['code', 'html', 'message'])
    expect(body).not.toHaveProperty('stack')
    expect(body).not.toHaveProperty('detail')
  })
})
