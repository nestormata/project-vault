import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'

const getPreviewProjectMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/state/preview-project.svelte.js', () => ({
  getPreviewProject: getPreviewProjectMock,
}))

import PreviewPage from './+page.svelte'

afterEach(() => {
  cleanup()
  getPreviewProjectMock.mockReset()
})

describe('projects/preview +page.svelte', () => {
  it('renders the browser-not-ready copy when there is no preview project (e.g. server render)', () => {
    getPreviewProjectMock.mockReturnValue(null)
    render(PreviewPage, {})

    expect(screen.getByText(/^preview project$/i)).toBeTruthy()
    expect(screen.getByText(/created only in the browser and resets on reload/i)).toBeTruthy()
  })

  it('renders the empty-state dashboard for the preview project when one exists', () => {
    getPreviewProjectMock.mockReturnValue({
      id: 'preview',
      name: 'Preview Project',
      description: 'A temporary preview of the project-centered dashboard.',
      persisted: false,
      dashboard: { suggestedActions: [] },
    })
    render(PreviewPage, {})

    expect(screen.getByText(/preview only - this project is not saved/i)).toBeTruthy()
    expect(screen.getByText('A temporary preview of the project-centered dashboard.')).toBeTruthy()
  })
})
