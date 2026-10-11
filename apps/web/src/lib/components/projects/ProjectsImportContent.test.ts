import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { importProject, type ImportProjectResult } from '$lib/api/project-export.js'
import { goto } from '$app/navigation'
import ProjectsImportContent from './ProjectsImportContent.svelte'

// Story 62-2 AC-2/3/4/6: hardened export-key input, truthful file help, a count list for every
// non-zero entry, and a way back to the projects list.

vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$lib/api/project-export.js', () => ({ importProject: vi.fn() }))

const KEY = 'typed-export-key-1234'
const file = new File(['payload'], 'p.pvexport', { type: 'application/octet-stream' })

beforeEach(() => {
  vi.mocked(importProject).mockReset()
  vi.mocked(goto).mockReset()
})
afterEach(cleanup)

const keyInput = () => document.getElementById('export-key') as HTMLInputElement
const submitButton = () => screen.getByRole('button', { name: /^Import project$|^Importing/ })

// jsdom blocks a submit-button click while the `required` file input holds no real file, so the
// form's submit event is dispatched directly (the handler under test is the form's onsubmit).
async function submitForm(): Promise<void> {
  await fireEvent.submit(keyInput().closest('form') as HTMLFormElement)
}

async function fill(): Promise<void> {
  await fireEvent.change(document.getElementById('pvexport-file') as HTMLInputElement, {
    target: { files: [file] },
  })
  await fireEvent.input(keyInput(), { target: { value: `  ${KEY}  ` } })
}

async function importWith(importedCounts: Record<string, number>, name = 'Payments API') {
  vi.mocked(importProject).mockResolvedValueOnce({ projectId: 'new-1', name, importedCounts })
  render(ProjectsImportContent)
  await fill()
  await submitForm()
  await waitFor(() => expect(screen.getByText('Import complete')).toBeTruthy())
}

describe('ProjectsImportContent export key input (AC-2)', () => {
  it('is a hardened password input by default', () => {
    render(ProjectsImportContent)
    const input = keyInput()
    expect(input.tagName).toBe('INPUT')
    expect(input.getAttribute('type')).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('data-1p-ignore')).not.toBeNull()
    expect(input.getAttribute('data-lpignore')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('export-key-help')
    expect(document.getElementById('export-key-help')).toBeTruthy()
  })

  it('toggles between password and text with aria-pressed, keeping the value, right after the input', async () => {
    render(ProjectsImportContent)
    await fireEvent.input(keyInput(), { target: { value: KEY } })
    const toggle = screen.getByRole('button', { name: 'Show export key' })
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('aria-controls')).toBe('export-key')
    expect(
      keyInput().compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await fireEvent.click(toggle)
    expect(keyInput().getAttribute('type')).toBe('text')
    expect(keyInput().value).toBe(KEY)
    const hide = screen.getByRole('button', { name: 'Hide export key' })
    expect(hide.getAttribute('aria-pressed')).toBe('true')

    await fireEvent.click(hide)
    expect(keyInput().getAttribute('type')).toBe('password')
    expect(keyInput().value).toBe(KEY)
  })

  it('returns focus to the key input after toggling', async () => {
    render(ProjectsImportContent)
    await fireEvent.click(screen.getByRole('button', { name: 'Show export key' }))
    expect(document.activeElement).toBe(keyInput())
  })

  it('trims the key on submit', async () => {
    vi.mocked(importProject).mockResolvedValueOnce({
      projectId: 'p',
      name: 'n',
      importedCounts: {},
    })
    render(ProjectsImportContent)
    await fill()
    await submitForm()
    await waitFor(() => expect(importProject).toHaveBeenCalledTimes(1))
    expect(importProject).toHaveBeenCalledWith(fetch, file, KEY, undefined)
  })

  it('ignores a second submit while an import is in flight, with the toggle still usable', async () => {
    let release: (value: ImportProjectResult) => void = () => {}
    vi.mocked(importProject).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )
    render(ProjectsImportContent)
    await fill()
    await submitForm()
    await waitFor(() => expect((submitButton() as HTMLButtonElement).disabled).toBe(true))
    await fireEvent.submit(keyInput().closest('form') as HTMLFormElement)
    expect(importProject).toHaveBeenCalledTimes(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Show export key' }))
    expect(keyInput().getAttribute('type')).toBe('text')
    release({ projectId: 'p', name: 'n', importedCounts: {} })
    await waitFor(() => expect(screen.getByText('Import complete')).toBeTruthy())
  })

  it.each([
    ['import_decrypt_failed', 'could not be decrypted'],
    ['file_too_large', 'too large to import'],
  ])(
    'keeps the form, key and file after a %s failure so the user can retry',
    async (code, text) => {
      vi.mocked(importProject).mockRejectedValueOnce(new ApiClientError(400, { code }, 'x'))
      render(ProjectsImportContent)
      await fill()
      await submitForm()
      await waitFor(() => expect(document.body.textContent).toContain(text))
      expect(keyInput().value).toBe(`  ${KEY}  `)
      expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
    }
  )

  it('keeps the form after a network error', async () => {
    vi.mocked(importProject).mockRejectedValueOnce(new Error('Failed to fetch'))
    render(ProjectsImportContent)
    await fill()
    await submitForm()
    await waitFor(() => expect(screen.getByText('Failed to fetch')).toBeTruthy())
    expect(keyInput().value).toBe(`  ${KEY}  `)
  })

  it('removes the key input from the DOM after a successful import', async () => {
    await importWith({ credentials: 1 })
    expect(document.getElementById('export-key')).toBeNull()
  })
})

describe('ProjectsImportContent file help (AC-3)', () => {
  it('no longer says the file is never uploaded anywhere else', () => {
    render(ProjectsImportContent)
    const help = document.getElementById('pvexport-file-help')
    expect(help?.textContent).toBe(
      'The encrypted .pvexport file you downloaded when you exported the project. It is decrypted only with the key below and is not stored after import.'
    )
    expect(document.body.textContent).not.toContain('never uploaded anywhere else')
  })
})

describe('ProjectsImportContent result panel (AC-4)', () => {
  const items = () =>
    screen.queryAllByRole('listitem').map((li) => li.textContent?.replace(/\s+/g, ' ').trim())

  it('names the new project and lists non-zero counts in the fixed order', async () => {
    await importWith({
      rotations: 1,
      credentialVersions: 5,
      credentials: 2,
      certRecords: 0,
      domainRecords: 0,
    })
    expect(screen.getByText('Imported as a new project:')).toBeTruthy()
    expect(screen.getByText('Payments API').tagName).toBe('STRONG')
    expect(items()).toEqual(['Secrets: 2', 'Secret versions: 5', 'Rotations: 1'])
  })

  it('labels every known key in the fixed order', async () => {
    await importWith({
      machineUsers: 9,
      statusPages: 8,
      serviceEndpoints: 7,
      domainRecords: 6,
      certRecords: 5,
      rotations: 4,
      credentialDependencies: 3,
      credentialVersions: 2,
      credentials: 1,
    })
    expect(items()).toEqual([
      'Secrets: 1',
      'Secret versions: 2',
      'Dependencies: 3',
      'Rotations: 4',
      'Certificates: 5',
      'Domains: 6',
      'Service endpoints: 7',
      'Status pages: 8',
      'Machine users: 9',
    ])
  })

  it('shows an unknown positive key by its raw name and skips negative or non-number values', async () => {
    await importWith({
      futureThings: 3,
      credentials: 1,
      rotations: -2,
      statusPages: Number.NaN,
      machineUsers: 'x' as unknown as number,
    })
    expect(items()).toEqual(['Secrets: 1', 'futureThings: 3'])
  })

  it('shows a single "no items" line when every count is zero', async () => {
    await importWith({ credentials: 0, rotations: 0 })
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText('The export contained no items.')).toBeTruthy()
  })

  it('renders a hostile project name as text', async () => {
    await importWith({ credentials: 1 }, '<b>x</b> Export Source')
    expect(screen.getByText('<b>x</b> Export Source')).toBeTruthy()
    expect(document.querySelector('strong b')).toBeNull()
  })

  it('navigates to the imported project from View project', async () => {
    await importWith({ credentials: 1 })
    await fireEvent.click(screen.getByRole('button', { name: 'View project' }))
    expect(goto).toHaveBeenCalledWith('/projects/new-1')
  })
})

describe('ProjectsImportContent back link (AC-6)', () => {
  it('links back to the projects list on the form', () => {
    render(ProjectsImportContent)
    expect(screen.getByRole('link', { name: 'Back to projects' }).getAttribute('href')).toBe(
      '/projects'
    )
  })

  it('links back to the projects list on the success panel too', async () => {
    await importWith({ credentials: 1 })
    expect(screen.getByRole('link', { name: 'Back to projects' }).getAttribute('href')).toBe(
      '/projects'
    )
  })
})
