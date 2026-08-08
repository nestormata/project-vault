import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import ShareRevealContent from './ShareRevealContent.svelte'

describe('ShareRevealContent', () => {
  it('renders the shared value component and preserves the reveal action contract', () => {
    const onReveal = vi.fn()

    render(ShareRevealContent, {
      props: {
        revealedValue: '[{"key":"username","value":"riley","sensitive":false}]',
        valueFormat: 'fields',
        revealError: null,
        revealing: false,
        onReveal,
        buttonLabel: 'Reveal',
        expiredMessage: 'This share has expired.',
        alreadyViewedMessage: 'This share has already been viewed.',
        revokedMessage: 'This share has been revoked.',
        otherMessage: 'Could not reveal this share. Try again.',
      },
    })

    expect(screen.getByText('username')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
