import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { latestChangelogEntry } from './lib/extension-api-changelog.js'
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

// Story 68.11 AC-1 — the legacy panel / navItems / moduleDataRoutes surface carries
// policy-grade markers on the real `index.ts`, announced by the real CHANGELOG.
const LEGACY_DEPRECATED_EXPORTS = [
  'UIPanel',
  'UIPanelContext',
  'UIPanelResult',
  'ModuleAction',
  'ModuleActionRequest',
  'ModuleActionContext',
  'ActionResult',
  'ModuleDataRequestContext',
  'ModuleDataResult',
  'ModuleDataRouteHandler',
  'ExtensionNavItem',
  'ModuleDataRouteDeclaration',
]

describe('Story 68.11 — the legacy UI-panel surface is deprecated through the policy lifecycle', () => {
  const indexSource = readFileSync('packages/extension-api/src/index.ts', 'utf8')
  const changelogSource = readFileSync('packages/extension-api/CHANGELOG.md', 'utf8')
  const manifestSource = readFileSync('packages/extension-api/src/manifest.ts', 'utf8')
  const { version } = JSON.parse(readFileSync('packages/extension-api/package.json', 'utf8')) as {
    version: string
  }

  it('passes the real marker lint', () => {
    expect(
      checkDeprecationMarkers({ indexSource, changelogSource, currentVersion: version })
    ).toEqual([])
  })

  // The five marker lines directly above a declaration line, with the doc indentation stripped.
  function markerAbove(source: string, declaration: (line: string) => boolean): string[] {
    const lines = source.split('\n')
    const at = lines.findIndex(declaration)
    expect(at).toBeGreaterThanOrEqual(6)
    return lines.slice(at - 6, at).map((line) => line.trim())
  }

  function expectPolicyMarker(marker: string[]): void {
    expect(marker[0]).toBe('/**')
    expect(marker[1]).toBe('* @deprecated')
    expect(marker[2]).toMatch(/^\* replacement: \S/)
    expect(marker[3]).toBe('* earliest-removal: 4.0.0')
    expect(marker[4]).toMatch(/^\* notice-window-ends: \d{4}-\d{2}-\d{2}$/)
    expect(marker[5]).toBe('*/')
  }

  it.each(LEGACY_DEPRECATED_EXPORTS)('%s has a @deprecated marker on its index export', (name) => {
    expectPolicyMarker(
      markerAbove(indexSource, (line) => line.startsWith(`export type { ${name} } from `))
    )
  })

  it.each(['uiPanelSlots', 'moduleActions', 'navItems', 'moduleDataRoutes'])(
    'manifest field %s carries a field-level @deprecated marker',
    (field) => {
      const marker = markerAbove(manifestSource, (line) => line.startsWith(`  ${field}?:`))
      // A field's JSDoc starts earlier than the five-line window; check its tail.
      expect(marker.slice(0, 5).join('\n')).toContain('@deprecated')
      expect(marker.join('\n')).toMatch(/earliest-removal: 4\.0\.0/)
      expect(marker[4]).toMatch(/^\* notice-window-ends: \d{4}-\d{2}-\d{2}$/)
      expect(marker[5]).toBe('*/')
    }
  )

  it('the newest CHANGELOG entry lists the deprecated fields, hooks and capability member', () => {
    const entry = latestChangelogEntry(changelogSource) ?? ''
    for (const token of [
      'uiPanelSlots',
      'moduleActions',
      'navItems',
      'moduleDataRoutes',
      '`uiPanel`',
      '`moduleAction`',
      '`moduleData`',
      "'ui-panel'",
      'ExtensionRequestContext',
      'ExtensionActionResult',
      'Notified:',
    ])
      expect(entry).toContain(token)
  })
})
