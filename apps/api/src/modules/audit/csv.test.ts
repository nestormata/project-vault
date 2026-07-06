import { describe, it, expect } from 'vitest'
import { toCsvRow, AUDIT_EXPORT_CSV_HEADER } from './csv.js'

describe('toCsvRow (D9, AC-12)', () => {
  it('leaves a plain field unquoted', () => {
    expect(toCsvRow(['credential', 'created'])).toBe('credential,created')
  })

  it('quotes and doubles embedded quotes for a field with a comma and quotes', () => {
    expect(toCsvRow(['Chen, Alice "AC"'])).toBe('"Chen, Alice ""AC"""')
  })

  it('quotes a field containing only a comma', () => {
    expect(toCsvRow(['a,b'])).toBe('"a,b"')
  })

  it('quotes a field containing only a quote', () => {
    expect(toCsvRow(['a"b'])).toBe('"a""b"')
  })

  it('quotes a field containing a carriage return', () => {
    expect(toCsvRow(['a\rb'])).toBe('"a\rb"')
  })

  it('quotes a field containing a newline', () => {
    expect(toCsvRow(['a\nb'])).toBe('"a\nb"')
  })

  it('renders null/undefined fields as empty, unquoted', () => {
    expect(toCsvRow([null, undefined, 'x'])).toBe(',,x')
  })

  it('joins multiple fields with commas', () => {
    expect(
      toCsvRow([
        '2026-07-03T14:22:01.000Z',
        'Alice Chen',
        'credential.value_revealed',
        'c3d4',
        'credential',
        'e5f6',
        'proj1',
        '203.0.113.10',
      ])
    ).toBe(
      '2026-07-03T14:22:01.000Z,Alice Chen,credential.value_revealed,c3d4,credential,e5f6,proj1,203.0.113.10'
    )
  })

  it('exports the fixed 8-column header in the AC-E8c order', () => {
    expect(AUDIT_EXPORT_CSV_HEADER).toBe(
      'timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address'
    )
  })
})
