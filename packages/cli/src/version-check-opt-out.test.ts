import { describe, expect, it } from 'vitest'
import { noVersionCheckWarning, parseNoVersionCheck } from './version-check-opt-out.js'

describe('parseNoVersionCheck (Story 43.6 D10)', () => {
  it.each<[string | undefined, boolean, boolean]>([
    [undefined, false, false],
    ['', false, false],
    ['  ', false, false],
    ['1', true, false],
    ['true', true, false],
    ['TRUE', true, false],
    [' true ', true, false],
    ['1 ', true, false],
    ['0', false, false],
    ['false', false, false],
    ['FALSE', false, false],
    ['yes', false, true],
    ['2', false, true],
    ['on', false, true],
    ['x'.repeat(300), false, true],
  ])('%j → suppress=%s invalid=%s', (raw, suppress, invalid) => {
    expect(parseNoVersionCheck(raw)).toEqual({ suppress, invalid })
  })
})

describe('noVersionCheckWarning', () => {
  it('renders the D10 warning line', () => {
    expect(noVersionCheckWarning('yes')).toBe(
      'warning: ignoring PVAULT_NO_VERSION_CHECK=yes; use 1 or true to silence version notices\n'
    )
  })

  it('sanitizes and truncates a hostile value', () => {
    const line = noVersionCheckWarning(`\x1b[31m\u202Eevil${'z'.repeat(300)}`)
    expect(line).not.toContain('\x1b')
    expect(line).not.toContain('\u202E')
    expect(line).toContain('[31mevil')
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(200)
  })
})
