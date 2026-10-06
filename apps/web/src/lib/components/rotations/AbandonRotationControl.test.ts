import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'

const abandonRotationMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/rotations.js', () => ({ abandonRotation: abandonRotationMock }))

import AbandonRotationControl from './AbandonRotationControl.svelte'

function renderControl(disabled = false) {
  const callbacks = {
    onAbandoned: vi.fn(),
    onConcurrentModification: vi.fn(),
  }
  render(AbandonRotationControl, {
    props: {
      projectId: 'p',
      credentialId: 'c',
      rotationId: 'r',
      triggerLabel: 'Abandon rotation',
      confirmCopy: 'Custom confirm copy.',
      disabled,
      ...callbacks,
    },
  })
  return callbacks
}

describe('AbandonRotationControl', () => {
  beforeEach(() => abandonRotationMock.mockReset())
  afterEach(() => cleanup())

  it('renders the caller-supplied trigger label and confirm copy', async () => {
    renderControl()

    await fireEvent.click(screen.getByRole('button', { name: 'Abandon rotation' }))

    expect(screen.getByText('Custom confirm copy.')).toBeTruthy()
    expect(screen.getByRole('group', { name: /confirm abandon rotation/i })).toBeTruthy()
    expect(abandonRotationMock).not.toHaveBeenCalled()
  })

  it('hands the updated rotation to onAbandoned on success', async () => {
    const updated = { id: 'r', status: 'abandoned' }
    abandonRotationMock.mockResolvedValue(updated)
    const { onAbandoned } = renderControl()

    await fireEvent.click(screen.getByRole('button', { name: 'Abandon rotation' }))
    await fireEvent.click(screen.getByRole('button', { name: /abandon anyway/i }))

    await waitFor(() => expect(onAbandoned).toHaveBeenCalledWith(updated))
  })

  it('disables the trigger when the parent marks it disabled', () => {
    renderControl(true)

    expect(screen.getByRole('button', { name: 'Abandon rotation' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})
