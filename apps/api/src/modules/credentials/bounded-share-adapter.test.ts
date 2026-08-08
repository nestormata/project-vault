import { describe, expect, it } from 'vitest'
import { formatBoundedRevealValue } from './bounded-share-adapter.js'

describe('formatBoundedRevealValue', () => {
  it('preserves scalar values and identifies their format', () => {
    expect(formatBoundedRevealValue({ status: 'ok', kind: 'value', value: 'secret' })).toEqual({
      value: 'secret',
      valueFormat: 'scalar',
    })
  })

  it('serializes structured fields and identifies their format', () => {
    expect(
      formatBoundedRevealValue({
        status: 'ok',
        kind: 'fields',
        fields: [{ key: 'username', value: 'riley', sensitive: false }],
      })
    ).toEqual({
      value: '[{"key":"username","value":"riley","sensitive":false}]',
      valueFormat: 'fields',
    })
  })
})
