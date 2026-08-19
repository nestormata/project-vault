import { describe, expect, it } from 'vitest'
import { checkExperimentalMarkers, checkDeprecationMarkers } from './check-extension-api-markers.js'

const CURRENT_CHANGELOG = '# Changelog\n\n## 1.4.0 — 2026-08-18'
const CURRENT_DEPRECATED_CHANGELOG = `${CURRENT_CHANGELOG}\n\n### Deprecated\n\n- OldFoo\n`

describe('extension API marker guards', () => {
  it('accepts the current surface, which has no experimental or deprecated exports', () => {
    expect(checkExperimentalMarkers('export type Stable = { value: string }')).toEqual([])
    expect(
      checkDeprecationMarkers({
        indexSource: 'export type Stable = { value: string }',
        changelogSource: CURRENT_CHANGELOG,
        currentVersion: '1.4.0',
      })
    ).toEqual([])
  })

  it.each([
    ['experimental export without tag', 'export type Unstable_Foo = string', '@experimental'],
    [
      'experimental tag without prefix',
      '/** @experimental */\nexport type Foo = string',
      'Unstable_',
    ],
  ])('rejects %s', (_label, source, expected) => {
    expect(checkExperimentalMarkers(source).join('\n')).toContain(expected)
  })

  it('checks the exported name on aliased exports', () => {
    expect(
      checkExperimentalMarkers('/** @experimental */\nexport { Foo as Unstable_Foo }')
    ).toEqual([])
    expect(
      checkExperimentalMarkers('/** @experimental */\nexport { Unstable_Foo as Foo }').join('\n')
    ).toContain('Unstable_')
  })

  it.each([
    ['replacement', '@deprecated\n * earliest-removal: 2.0.0\n * notice-window-ends: 2026-12-01'],
    ['earliest-removal', '@deprecated\n * replacement: NewFoo\n * notice-window-ends: 2026-12-01'],
    ['notice-window-ends', '@deprecated\n * replacement: NewFoo\n * earliest-removal: 2.0.0'],
  ])('rejects a deprecated export missing %s', (_field, tag) => {
    const errors = checkDeprecationMarkers({
      indexSource: `/**\n * ${tag}\n */\nexport type OldFoo = string`,
      changelogSource: CURRENT_CHANGELOG,
      currentVersion: '1.4.0',
    })
    expect(errors.join('\n')).toContain(_field)
  })

  it('rejects an earliest-removal in the current major and a notice date under 90 days', () => {
    const errors = checkDeprecationMarkers({
      indexSource: `/**\n * @deprecated\n * replacement: NewFoo\n * earliest-removal: 1.5.0\n * notice-window-ends: 2026-08-19\n */\nexport type OldFoo = string`,
      changelogSource: '# Changelog\n\n## 1.4.0 — 2026-08-18',
      currentVersion: '1.4.0',
    })
    expect(errors.join('\n')).toContain('higher major')
    expect(errors.join('\n')).toContain('90 days')
  })

  it('rejects calendar-invalid notice dates instead of allowing Date normalization', () => {
    const errors = checkDeprecationMarkers({
      indexSource: `/**
 * @deprecated
 * replacement: NewFoo
 * earliest-removal: 2.0.0
 * notice-window-ends: 2026-02-30
 */
export type OldFoo = string`,
      changelogSource: '# Changelog\n\n## 1.4.0 — 2026-01-01',
      currentVersion: '1.4.0',
    })
    expect(errors.join('\n')).toContain('invalid notice-window-ends')
  })

  it('accepts a fully specified deprecation after the notice window', () => {
    expect(
      checkDeprecationMarkers({
        indexSource: `/**\n * @deprecated\n * replacement: NewFoo\n * earliest-removal: 2.0.0\n * notice-window-ends: 2026-11-16\n */\nexport type OldFoo = string`,
        changelogSource: CURRENT_DEPRECATED_CHANGELOG,
        currentVersion: '1.4.0',
      })
    ).toEqual([])
  })

  it('requires the newest CHANGELOG entry to announce each deprecated export', () => {
    const errors = checkDeprecationMarkers({
      indexSource: `/**
 * @deprecated
 * replacement: NewFoo
 * earliest-removal: 2.0.0
 * notice-window-ends: 2026-11-16
 */
export type OldFoo = string`,
      changelogSource: CURRENT_CHANGELOG,
      currentVersion: '1.4.0',
    })

    expect(errors.join('\n')).toContain('CHANGELOG')
  })
})
