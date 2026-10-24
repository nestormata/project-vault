import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.14: the backups page's sections are sub-regions. A probe contribution lands BETWEEN the
// two PV sections it was meant to sit between, and the list, the banners and the restore panel
// keep ONE owner (the controller) shared by the sections that read or drive it.

const listMock = vi.hoisted(() => vi.fn())
const triggerMock = vi.hoisted(() => vi.fn())
const validateMock = vi.hoisted(() => vi.fn())
const restoreMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/platform/backups' }, params: {} } }))
vi.mock('$lib/api/platform.js', () => ({
  listBackups: listMock,
  triggerBackup: triggerMock,
  validateBackup: validateMock,
  restoreBackup: restoreMock,
}))

const POINTS = [
  'platform.backups.intro',
  'platform.backups.alerts',
  'platform.backups.list',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const FILE = 'vault-2026-10-01.pvbak'
const BACKUP = {
  filename: FILE,
  timestamp: '2026-10-01T03:00:00.000Z',
  sizeBytes: 2048,
  keyVersion: 3,
  verified: 'unverified',
  status: 'succeeded',
  errorMessage: null,
}
const RUNNING = { ...BACKUP, filename: 'vault-running.pvbak', status: 'running' }
const pageData = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  backups: [BACKUP],
  errorMessage: null,
  ...overrides,
})

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./PlatformBackupsContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  listMock.mockReset()
  triggerMock.mockReset()
  validateMock.mockReset()
  restoreMock.mockReset()
  listMock.mockResolvedValue({ items: [BACKUP] })
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Content, { props: { pageData: pageData(overrides), data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const trigger = () => screen.getByRole('button', { name: 'Trigger backup now' })
const clickTrigger = async () => {
  await fireEvent.click(trigger())
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm trigger?' }))
}
const openRestore = async () => {
  await fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
}
const armRestore = async (reason = 'disaster drill') => {
  await openRestore()
  await fireEvent.input(document.getElementById('restore-typed-confirm') as HTMLElement, {
    target: { value: FILE },
  })
  await fireEvent.input(screen.getByPlaceholderText('Enter reason for restore'), {
    target: { value: reason },
  })
}
const restoreButton = (): HTMLButtonElement =>
  screen.getAllByRole('button', { name: /^Restor/ }).at(-1) as HTMLButtonElement

describe('PlatformBackupsContent sub-regions (AC-4 probe order)', () => {
  it('intro: after the trigger control, before the list', () => {
    mount()
    const intro = probe('platform.backups.intro')
    expect(follows(trigger(), intro)).toBe(true)
    expect(follows(intro, probe('platform.backups.alerts'))).toBe(true)
  })

  it('alerts: after the intro, before the list, even with no banner', () => {
    mount()
    const alerts = probe('platform.backups.alerts')
    expect(follows(probe('platform.backups.intro'), alerts)).toBe(true)
    expect(follows(alerts, screen.getByRole('table'))).toBe(true)
  })

  it('alerts: lands after the page-load error banner', () => {
    mount({ errorMessage: 'Failed to load backups' })
    expect(
      follows(screen.getByText('Failed to load backups'), probe('platform.backups.alerts'))
    ).toBe(true)
  })

  it('list: after the table, last on the page', () => {
    mount()
    const list = probe('platform.backups.list')
    expect(follows(screen.getByRole('table'), list)).toBe(true)
    expect(follows(probe('platform.backups.alerts'), list)).toBe(true)
  })

  it('list: renders the empty state before the point when there are no backups', () => {
    mount({ backups: [] })
    expect(follows(screen.getByText('No backups yet.'), probe('platform.backups.list'))).toBe(true)
  })

  it('list: a load error with no backups shows the table instead of the empty state', () => {
    mount({ backups: [], errorMessage: 'down' })
    expect(screen.queryByText('No backups yet.')).toBeNull()
    expect(screen.getByRole('table')).toBeTruthy()
  })

  it('renders no sub-region when the caller is not a platform operator', () => {
    render(Content, { props: { pageData: { allowed: false }, data: fills } })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('PlatformBackupsContent shared state (AC-4 interaction)', () => {
  it('triggering a backup shows the banner above the list and refreshes the list', async () => {
    triggerMock.mockResolvedValue({ jobId: 'job-7', status: 'running' })
    listMock.mockResolvedValue({ items: [BACKUP, RUNNING] })
    mount()
    expect(screen.queryByRole('status')).toBeNull()
    await clickTrigger()
    const banner = await screen.findByText(/Backup triggered \(job job-7\)/)
    expect(follows(probe('platform.backups.intro'), banner)).toBe(true)
    expect(follows(banner, probe('platform.backups.alerts'))).toBe(true)
    expect(await screen.findByText('vault-running.pvbak')).toBeTruthy()
  })

  it.each([
    [409, 'backup_already_running', 'A backup is already in progress.'],
    [429, undefined, 'Too many trigger attempts — wait a moment and try again.'],
  ])('a %i trigger failure shows its alert', async (status, code, message) => {
    triggerMock.mockRejectedValue(new ApiClientError(status, code ? { code } : null, message))
    mount()
    await clickTrigger()
    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('a sealed 503 explains the vault was sealed', async () => {
    triggerMock.mockRejectedValue(new ApiClientError(503, { status: 'sealed' } as never, 'x'))
    mount()
    await clickTrigger()
    expect(await screen.findByText(/The vault was sealed while you were on this page/)).toBeTruthy()
  })

  it('validate shows the result row under its backup, with a checksum warning', async () => {
    validateMock.mockResolvedValue({
      valid: false,
      checksum: 'mismatch',
      assetsPresent: {
        credentials: true,
        projects: false,
        users: true,
        auditEvents: true,
        dataErasureRequests: false,
      },
    })
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByText(/Checksum mismatch — this backup file/)).toBeTruthy()
    expect(screen.getByText('Projects: ✗ Missing')).toBeTruthy()
    expect(screen.getByText('Secrets: ✓')).toBeTruthy()
    expect(validateMock).toHaveBeenCalledWith(expect.anything(), FILE)
  })

  it('a failed validate shows its error under the backup', async () => {
    validateMock.mockRejectedValue(new ApiClientError(500, null, 'Validation exploded'))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(await screen.findByText('Validation exploded')).toBeTruthy()
  })

  it('a running backup offers neither validate nor restore', () => {
    mount({ backups: [RUNNING] })
    expect(screen.queryByRole('button', { name: 'Validate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull()
  })

  it('restore stays disabled until the filename is typed and a reason is given', async () => {
    mount()
    await openRestore()
    expect(restoreButton().disabled).toBe(true)
    await fireEvent.input(document.getElementById('restore-typed-confirm') as HTMLElement, {
      target: { value: FILE },
    })
    expect(restoreButton().disabled).toBe(true)
    await fireEvent.input(screen.getByPlaceholderText('Enter reason for restore'), {
      target: { value: '   ' },
    })
    expect(restoreButton().disabled).toBe(true)
    await fireEvent.input(screen.getByPlaceholderText('Enter reason for restore'), {
      target: { value: 'drill' },
    })
    expect(restoreButton().disabled).toBe(false)
  })

  it('cancelling the restore panel closes it and a reopen starts empty', async () => {
    mount()
    await armRestore()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('Enter reason for restore')).toBeNull()
    await openRestore()
    expect(
      (screen.getByPlaceholderText('Enter reason for restore') as HTMLTextAreaElement).value
    ).toBe('')
    expect(restoreButton().disabled).toBe(true)
  })

  it('a successful restore posts the reason, closes the panel and shows the unseal banner above the list', async () => {
    restoreMock.mockResolvedValue(undefined)
    mount()
    await armRestore('disaster drill')
    await fireEvent.click(restoreButton())
    const banner = await screen.findByText('Restore complete.')
    expect(restoreMock).toHaveBeenCalledWith(expect.anything(), FILE, {
      confirmRestore: true,
      reason: 'disaster drill',
    })
    expect(follows(banner, screen.getByRole('table'))).toBe(true)
    expect(follows(probe('platform.backups.intro'), banner)).toBe(true)
    expect(screen.queryByPlaceholderText('Enter reason for restore')).toBeNull()
    expect(screen.getByRole('link', { name: /Unseal vault/ })).toBeTruthy()
  })

  it('a 404 restore failure shows its error in the panel and refreshes the list', async () => {
    restoreMock.mockRejectedValue(new ApiClientError(404, null, 'gone'))
    mount()
    await armRestore()
    await fireEvent.click(restoreButton())
    expect(await screen.findByText('No backup found with that filename.')).toBeTruthy()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(screen.getByPlaceholderText('Enter reason for restore')).toBeTruthy()
  })

  it.each([
    [409, 'restore_in_progress', 'Another restore is already in progress.'],
    [409, 'backup_in_progress', 'A backup is currently running.'],
    [401, 'backup_decrypt_failed', 'Backup could not be decrypted'],
    [422, 'backup_checksum_mismatch', 'Stored checksum does not match'],
    [500, undefined, 'Restore failed unexpectedly.'],
  ])('a %i %s restore failure explains itself', async (status, code, text) => {
    restoreMock.mockRejectedValue(new ApiClientError(status, code ? { code } : null, 'raw'))
    mount()
    await armRestore()
    await fireEvent.click(restoreButton())
    expect((await screen.findByRole('alert')).textContent).toContain(text)
  })
})
