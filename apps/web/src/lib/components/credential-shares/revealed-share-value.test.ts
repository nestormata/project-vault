import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import RevealedShareValue from './RevealedShareValue.svelte'

afterEach(() => cleanup())

describe('RevealedShareValue', () => {
  it('renders multi-field JSON reveals as labeled key/value rows instead of raw JSON', () => {
    render(RevealedShareValue, {
      props: {
        value: JSON.stringify([
          { key: 'username', value: 'svc-account' },
          { key: 'password', value: 'super-secret' },
        ]),
        valueFormat: 'fields',
      },
    })

    expect(screen.getByRole('term', { name: 'username' })).toBeTruthy()
    expect(screen.getByRole('definition', { name: 'svc-account' })).toBeTruthy()
    expect(screen.getByRole('term', { name: 'password' })).toBeTruthy()
    expect(screen.getByRole('definition', { name: 'super-secret' })).toBeTruthy()
    expect(screen.queryByText(/\[\{"key"/)).toBeNull()
  })

  it('does not reinterpret a scalar JSON secret as a field set', () => {
    render(RevealedShareValue, {
      props: { value: '{"key":"value"}', valueFormat: 'scalar' },
    })

    expect(screen.getByText('{"key":"value"}')).toBeTruthy()
    expect(screen.queryByRole('term')).toBeNull()
  })

  it('keeps scalar and malformed legacy values readable without throwing', () => {
    const { unmount } = render(RevealedShareValue, { props: { value: 'plain-secret' } })
    expect(screen.getByText('plain-secret')).toBeTruthy()

    unmount()
    render(RevealedShareValue, { props: { value: '{not-json' } })
    expect(screen.getByText('{not-json')).toBeTruthy()
  })
})
