import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { ApiClientError } from '$lib/api/client.js'

const triggerBackupMock = vi.hoisted(() => vi.fn())
const validateBackupMock = vi.hoisted(() => vi.fn())
const restoreBackupMock = vi.hoisted(() => vi.fn())
const listBackupsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', () => ({
  triggerBackup: triggerBackupMock,
  validateBackup: validateBackupMock,
  restoreBackup: restoreBackupMock,
  listBackups: listBackupsMock,
}))

import BackupsPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE_BACKUP = {
  filename: 'backup_20260701T030000Z_org-abc.vault',
  timestamp: '2026-07-01T03:00:00.000Z',
  sizeBytes: 2_400_000_000,
  keyVersion: 1,
  verified: 'valid' as const,
  status: 'succeeded' as const,
  errorMessage: null,
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    backups: [SAMPLE_BACKUP],
    errorMessage: null,
    ...overrides,
  }
}

async function confirmClick(name: RegExp) {
  const button = screen.getByRole('button', { name })
  await fireEvent.click(button)
  await fireEvent.click(button)
}

describe('/platform/backups +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/backups')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(BackupsPage, { props: { data: { allowed: false } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByText(/no backups yet/i)).toBeNull()
  })

  it('renders a real backup row with formatted size and status', () => {
    render(BackupsPage, { props: { data: allowedData() } })

    expect(screen.getByText('backup_20260701T030000Z_org-abc.vault')).toBeTruthy()
    expect(screen.getByText('Succeeded')).toBeTruthy()
    expect(screen.getByText('Valid ✓')).toBeTruthy()
  })

  it('edge: shows an empty state when there are no backups', () => {
    render(BackupsPage, { props: { data: allowedData({ backups: [] }) } })

    expect(screen.getByText(/no backups yet/i)).toBeTruthy()
  })

  it('surfaces a load-time errorMessage', () => {
    render(BackupsPage, {
      props: { data: allowedData({ errorMessage: 'Failed to load backups' }) },
    })

    expect(screen.getByText('Failed to load backups')).toBeTruthy()
  })

  it('failed backup row shows the error message inline; running row hides Validate/Restore', () => {
    render(BackupsPage, {
      props: {
        data: allowedData({
          backups: [
            { ...SAMPLE_BACKUP, status: 'failed', errorMessage: 'Disk full', verified: 'invalid' },
            { ...SAMPLE_BACKUP, filename: 'running.vault', status: 'running' },
          ],
        }),
      },
    })

    expect(screen.getByText(/Failed.*Disk full/)).toBeTruthy()
    expect(screen.getByText('Invalid ✗')).toBeTruthy()
    expect(screen.getByText('Running…')).toBeTruthy()
    // Only one row (the succeeded-like failed one doesn't count) should expose Validate/Restore;
    // the running row must not.
    expect(screen.getAllByRole('button', { name: /^validate$/i })).toHaveLength(1)
  })

  it('trigger backup: two-step confirm calls triggerBackup and shows a success message with job id', async () => {
    triggerBackupMock.mockResolvedValue({ jobId: 'job-123' })
    listBackupsMock.mockResolvedValue({ items: [SAMPLE_BACKUP] })
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(await screen.findByText(/backup triggered \(job job-123\)/i)).toBeTruthy()
    expect(triggerBackupMock).toHaveBeenCalledTimes(1)
    expect(listBackupsMock).toHaveBeenCalledTimes(1)
  })

  it('trigger backup: 409 already-running shows a specific error, no crash', async () => {
    triggerBackupMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'backup_already_running', message: 'A backup is already running.' },
        'A backup is already running.'
      )
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(await screen.findByText('A backup is already running.')).toBeTruthy()
  })

  it('trigger backup: 503 with vault-sealed body shape shows the unseal message', async () => {
    triggerBackupMock.mockRejectedValue(
      new ApiClientError(503, { status: 'sealed' }, 'Vault sealed')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(await screen.findByText(/unseal it to continue/i)).toBeTruthy()
  })

  it('trigger backup: 503 with backup-not-configured body shows that message', async () => {
    triggerBackupMock.mockRejectedValue(
      new ApiClientError(
        503,
        { code: 'backup_not_configured', message: 'Backup is not configured on this instance.' },
        'Backup is not configured on this instance.'
      )
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(await screen.findByText('Backup is not configured on this instance.')).toBeTruthy()
  })

  it('validate: shows valid result details including asset presence checklist', async () => {
    validateBackupMock.mockResolvedValue({
      valid: true,
      checksum: 'match',
      assetsPresent: {
        credentials: true,
        projects: true,
        users: true,
        auditEvents: true,
        dataErasureRequests: false,
      },
    })
    listBackupsMock.mockResolvedValue({ items: [SAMPLE_BACKUP] })
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^validate$/i }))

    expect(await screen.findByText('✓ Valid')).toBeTruthy()
    expect(screen.getByText(/data erasure requests: ✗ missing/i)).toBeTruthy()
    expect(validateBackupMock).toHaveBeenCalledWith(expect.anything(), SAMPLE_BACKUP.filename)
  })

  it('validate: checksum mismatch shows the corruption warning', async () => {
    validateBackupMock.mockResolvedValue({
      valid: false,
      checksum: 'mismatch',
      assetsPresent: {
        credentials: true,
        projects: true,
        users: true,
        auditEvents: true,
        dataErasureRequests: true,
      },
    })
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^validate$/i }))

    expect(await screen.findByText('✗ Invalid')).toBeTruthy()
    expect(screen.getByText(/checksum mismatch — this backup file may be corrupted/i)).toBeTruthy()
  })

  it('validate: API failure shows an inline error row, not a crash', async () => {
    validateBackupMock.mockRejectedValue(
      new ApiClientError(500, { message: 'Validation failed' }, 'Validation failed')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^validate$/i }))

    expect(await screen.findByText('Validation failed')).toBeTruthy()
  })

  it('restore: opening the panel requires typed filename match and a reason before Restore enables', async () => {
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))

    // There are now two "restore" named buttons (open trigger + confirm); pick the confirm one.
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    const confirmButton = restoreButtons[restoreButtons.length - 1] as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)

    const typedInput = screen.getByLabelText(/type the exact filename to confirm/i)
    await fireEvent.input(typedInput, { target: { value: SAMPLE_BACKUP.filename } })
    const reasonBox = screen.getByPlaceholderText(/enter reason for restore/i)
    await fireEvent.input(reasonBox, { target: { value: 'Recovering from bad deploy' } })

    expect(confirmButton.disabled).toBe(false)
  })

  it('restore: cancel closes the panel without calling the API', async () => {
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    expect(screen.getByText(/restore is destructive and irreversible/i)).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(screen.queryByText(/restore is destructive and irreversible/i)).toBeNull()
    expect(restoreBackupMock).not.toHaveBeenCalled()
  })

  it('restore: successful restore shows the sealed-vault success message with an unseal link', async () => {
    restoreBackupMock.mockResolvedValue(undefined)
    listBackupsMock.mockResolvedValue({ items: [SAMPLE_BACKUP] })
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText(/restore complete/i)).toBeTruthy()
    const unsealLink = screen.getByRole('link', { name: /unseal vault/i })
    expect(routeExists(unsealLink.getAttribute('href') ?? '')).toBe(true)
    expect(restoreBackupMock).toHaveBeenCalledWith(expect.anything(), SAMPLE_BACKUP.filename, {
      confirmRestore: true,
      reason: 'Recovering from bad deploy',
    })
  })

  it('restore: checksum mismatch (422) shows the tamper-refusal message', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(422, { code: 'backup_checksum_mismatch' }, 'Checksum mismatch')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(
      await screen.findByText(/refusing to restore a potentially corrupted or tampered backup/i)
    ).toBeTruthy()
  })

  it('restore: 401 decrypt failure shows the master-key message', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(401, { code: 'backup_decrypt_failed' }, 'Decrypt failed')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(
      await screen.findByText(/could not be decrypted with the current master key/i)
    ).toBeTruthy()
  })

  it('restore: 409 restore_in_progress vs backup_in_progress show distinct messages', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(409, { code: 'restore_in_progress' }, 'conflict')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText(/another restore is already in progress/i)).toBeTruthy()
  })

  it('restore: 404 shows not-found message and refreshes the list', async () => {
    restoreBackupMock.mockRejectedValue(new ApiClientError(404, {}, 'not found'))
    listBackupsMock.mockResolvedValue({ items: [SAMPLE_BACKUP] })
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText(/no backup found with that filename/i)).toBeTruthy()
    expect(listBackupsMock).toHaveBeenCalledTimes(1)
  })

  it('restore: 409 with an unrecognized code falls back to the API message', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(409, { code: 'something_else' }, 'weird conflict')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText('weird conflict')).toBeTruthy()
  })

  it('restore: 400 confirmation_required shows the destructive-confirmation message', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(400, { code: 'confirmation_required' }, 'bad request')
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(
      await screen.findByText(/confirmRestore: true and a reason are both required/i)
    ).toBeTruthy()
  })

  it('restore: 400 invalid_filename shows the API-provided message', async () => {
    restoreBackupMock.mockRejectedValue(
      new ApiClientError(
        400,
        { code: 'invalid_filename', message: 'Bad filename shape' },
        'bad request'
      )
    )
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText('Bad filename shape')).toBeTruthy()
  })

  it('restore: 500 shows an unexpected-failure message', async () => {
    restoreBackupMock.mockRejectedValue(new ApiClientError(500, {}, 'server error'))
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText(/restore failed unexpectedly/i)).toBeTruthy()
  })

  it('restore: a non-ApiClientError (network failure) shows the generic restore-failed message', async () => {
    restoreBackupMock.mockRejectedValue(new Error('network down'))
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    await fireEvent.input(screen.getByLabelText(/type the exact filename to confirm/i), {
      target: { value: SAMPLE_BACKUP.filename },
    })
    await fireEvent.input(screen.getByPlaceholderText(/enter reason for restore/i), {
      target: { value: 'Recovering from bad deploy' },
    })
    const restoreButtons = screen.getAllByRole('button', { name: /^restore$/i })
    await fireEvent.click(restoreButtons[restoreButtons.length - 1])

    expect(await screen.findByText(/^restore failed\.$/i)).toBeTruthy()
  })

  it('restore: cancelling from the confirm step closes the panel via closeRestore', async () => {
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
    expect(screen.getByLabelText(/type the exact filename to confirm/i)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByLabelText(/type the exact filename to confirm/i)).toBeNull()
  })

  it('trigger backup: 429 rate limit shows a distinct throttling message', async () => {
    triggerBackupMock.mockRejectedValue(new ApiClientError(429, {}, 'rate limited'))
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(
      await screen.findByText(/too many trigger attempts — wait a moment and try again/i)
    ).toBeTruthy()
  })

  it('trigger backup: a non-ApiClientError failure shows the generic trigger-failed message', async () => {
    triggerBackupMock.mockRejectedValue(new Error('network down'))
    render(BackupsPage, { props: { data: allowedData() } })

    await confirmClick(/trigger backup now/i)

    expect(await screen.findByText(/^failed to trigger backup\.$/i)).toBeTruthy()
  })

  it('validate: a non-ApiClientError failure still shows an inline error row', async () => {
    validateBackupMock.mockRejectedValue(new Error('network down'))
    render(BackupsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^validate$/i }))

    expect(await screen.findByText(/validation failed/i)).toBeTruthy()
  })
})
