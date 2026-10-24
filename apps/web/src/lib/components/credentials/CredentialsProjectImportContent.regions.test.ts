import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the secrets import page body follows one step at a time, each a sub-region, then the
// error banner and the back link. A probe lands after its own section, and the flow keeps ONE owner
// of the step state across upload, preview and done.

const api = vi.hoisted(() => ({
  previewCredentialImport: vi.fn(),
  confirmCredentialImport: vi.fn(),
}))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/credentials/import' }, params: {} },
}))
vi.mock('$lib/api/credentials.js', () => ({
  previewCredentialImport: api.previewCredentialImport,
  confirmCredentialImport: api.confirmCredentialImport,
}))

const POINTS = [
  'project.credentials-import.done',
  'project.credentials-import.preview-table',
  'project.credentials-import.preview-actions',
  'project.credentials-import.upload',
  'project.credentials-import.error',
  'project.credentials-import.back',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const PREVIEW = {
  importId: 'imp-1',
  itemCount: 2,
  parsed: [
    { name: 'API_KEY', value: '***', conflictName: null, suggestedAction: 'create' },
    { name: 'DB_URL', value: '***', conflictName: 'DB_URL', suggestedAction: 'new_version' },
  ],
}

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./CredentialsProjectImportContent.svelte'))
    .default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  api.previewCredentialImport.mockReset()
  api.confirmCredentialImport.mockReset()
})
afterEach(cleanup)

const mount = (canImport = true) =>
  render(Content, { props: { pageData: { canImport, projectId: 'p1' }, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const pickFile = async () => {
  const file = new File(['API_KEY=1'], 'a.txt', { type: 'text/plain' })
  await fireEvent.change(document.getElementById('import-file') as HTMLInputElement, {
    target: { files: [file] },
  })
}
const toPreview = async () => {
  api.previewCredentialImport.mockResolvedValue(PREVIEW)
  mount()
  await pickFile()
  await screen.findByText('Preview (2 items)')
}

describe('CredentialsProjectImportContent sub-regions (probe order)', () => {
  it('upload step: the upload probe follows the picker, then the error and back probes', () => {
    mount()
    const upload = probe('project.credentials-import.upload')
    expect(follows(document.getElementById('import-file-help') as Node, upload)).toBe(true)
    expect(follows(upload, probe('project.credentials-import.error'))).toBe(true)
    expect(
      follows(probe('project.credentials-import.error'), probe('project.credentials-import.back'))
    ).toBe(true)
    expect(probeCount()).toBe(3)
  })

  it('preview step: table probe after the table, actions probe after the buttons', async () => {
    await toPreview()
    const table = probe('project.credentials-import.preview-table')
    const actions = probe('project.credentials-import.preview-actions')
    expect(follows(screen.getByRole('table'), table)).toBe(true)
    expect(follows(table, screen.getByRole('button', { name: 'Confirm import' }))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Upload different file' }), actions)).toBe(
      true
    )
    expect(actions.parentElement?.lastElementChild).toBe(actions)
    expect(screen.queryAllByTestId('probe').some((p) => p.textContent?.includes('.upload"'))).toBe(
      false
    )
  })

  it('done step: the done probe follows the link, and the back link is gone', async () => {
    await toPreview()
    api.confirmCredentialImport.mockResolvedValue({ imported: 1, newVersions: 1, skipped: 0 })
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }))
    const link = await screen.findByRole('link', { name: 'View secrets' })
    expect(follows(link, probe('project.credentials-import.done'))).toBe(true)
    expect(screen.getByText('Imported: 1')).toBeTruthy()
    expect(probeCount()).toBe(2)
  })

  it('renders no sub-region but the error one for a caller who cannot import', () => {
    mount(false)
    expect(screen.getByText('Import not available')).toBeTruthy()
    expect(probeCount()).toBe(1)
    expect(probe('project.credentials-import.error')).toBeTruthy()
  })
})

describe('CredentialsProjectImportContent flow state (interaction)', () => {
  it('maps a too-large upload to its copy and stays on the upload step', async () => {
    api.previewCredentialImport.mockRejectedValue(
      new ApiClientError(413, { code: 'import_too_large' }, 'raw')
    )
    mount()
    await pickFile()
    expect((await screen.findByRole('alert')).textContent?.trim()).toBe(
      'File is too large. Maximum size is 1 MB.'
    )
    expect(document.getElementById('import-file')).toBeTruthy()
  })

  it('"Upload different file" returns to the upload step', async () => {
    await toPreview()
    await fireEvent.click(screen.getByRole('button', { name: 'Upload different file' }))
    expect(document.getElementById('import-file')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('an expired preview sends the user back to upload with the expiry copy', async () => {
    await toPreview()
    api.confirmCredentialImport.mockRejectedValue(
      new ApiClientError(410, { code: 'import_expired' }, 'gone')
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }))
    await waitFor(() => expect(document.getElementById('import-file')).toBeTruthy())
    expect(screen.getByRole('alert').textContent?.trim()).toBe('Preview expired — upload again.')
  })

  it('confirms with the preview id and the new-version default', async () => {
    await toPreview()
    api.confirmCredentialImport.mockResolvedValue({ imported: 2, newVersions: 0, skipped: 0 })
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }))
    await waitFor(() =>
      expect(api.confirmCredentialImport).toHaveBeenCalledWith(fetch, 'p1', {
        importId: 'imp-1',
        defaultAction: 'new_version',
      })
    )
  })
})
