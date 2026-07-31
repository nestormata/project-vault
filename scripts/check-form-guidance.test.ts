import { describe, expect, it } from 'vitest'
import { scanFormGuidance } from './check-form-guidance'

const fixture = 'fixture.svelte'

describe('check-form-guidance', () => {
  it('reports a visible control without a visible description relationship', () => {
    const findings = scanFormGuidance(
      '<label for="name">Name</label>\n<input id="name" name="name" />',
      fixture
    )

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'fixture.svelte',
        line: 2,
        kind: 'missing-description',
        control: 'input#name',
      }),
    ])
  })

  it('requires every user-facing control type, including checkbox, radio, select, and textarea', () => {
    const source = [
      '<input type="checkbox" id="cacheable" />',
      '<input type="radio" id="role-admin" name="role" />',
      '<select id="role"></select>',
      '<textarea id="notes"></textarea>',
    ].join('\n')

    expect(scanFormGuidance(source, fixture)).toHaveLength(4)
  })

  it('accepts a visible description referenced by aria-describedby', () => {
    const source =
      '<input id="name" aria-describedby="name-help" />\n<p id="name-help">Used in the project list.</p>'

    expect(scanFormGuidance(source, fixture)).toEqual([])
  })

  it('does not report hidden inputs or option-only markup', () => {
    const source =
      '<input type="hidden" name="csrf" value={token} />\n<option value="admin">Admin</option>'

    expect(scanFormGuidance(source, fixture)).toEqual([])
  })

  it('reports missing referenced descriptions and duplicate description ids', () => {
    const source = [
      '<input id="one" aria-describedby="missing" />',
      '<input id="two" aria-describedby="help" />',
      '<p id="help">First explanation.</p>',
      '<p id="help">Second explanation.</p>',
    ].join('\n')

    expect(scanFormGuidance(source, fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-description-target', line: 1 }),
        expect.objectContaining({ kind: 'duplicate-description-id', line: 4 }),
      ])
    )
  })
})
