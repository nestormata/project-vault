import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import type { CredentialSummary } from '@project-vault/shared'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const createCredentialMock = vi.hoisted(() => vi.fn())
const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const previewCredentialImportMock = vi.hoisted(() => vi.fn())
const confirmCredentialImportMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$lib/api/credentials.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/credentials.js')>()
  return {
    ...original,
    createCredential: createCredentialMock,
    revealCredentialValue: revealCredentialValueMock,
    previewCredentialImport: previewCredentialImportMock,
    confirmCredentialImport: confirmCredentialImportMock,
  }
})

import CredentialsListPage from './(app)/projects/[projectId]/credentials/+page.svelte'
import CreateCredentialPage from './(app)/projects/[projectId]/credentials/new/+page.svelte'
import CredentialDetailPage from './(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte'
import ImportCredentialsPage from './(app)/projects/[projectId]/credentials/import/+page.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeCredential(overrides: Partial<CredentialSummary> = {}): CredentialSummary {
  return {
    id: overrides.id ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    projectId,
    name: overrides.name ?? 'Stripe Secret Key',
    description: null,
    tags: overrides.tags ?? ['api'],
    status: overrides.status ?? 'expiring',
    expiresAt: overrides.expiresAt ?? '2026-07-15T00:00:00.000Z',
    rotationSchedule: null,
    currentVersionNumber: 1,
    hasDependencies: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('project credential routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    gotoMock.mockClear()
    createCredentialMock.mockReset()
    revealCredentialValueMock.mockReset()
    previewCredentialImportMock.mockReset()
    confirmCredentialImportMock.mockReset()
    vi.spyOn(Storage.prototype, 'setItem')
    vi.spyOn(Storage.prototype, 'getItem')
  })

  afterEach(() => cleanup())

  it('list renders three credential rows from mocked load data', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          credentials: {
            items: [
              makeCredential({ name: 'Stripe Secret Key', status: 'expiring' }),
              makeCredential({
                id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                name: 'Legacy API Token',
                status: 'expired',
              }),
              makeCredential({
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                name: 'Internal Service Key',
                status: 'active',
                expiresAt: null,
              }),
            ],
            total: 3,
            page: 1,
            limit: 20,
            hasNext: false,
          },
          filters: { q: '', status: '', page: 1 },
        },
      },
    })

    expect(screen.getByText('Stripe Secret Key')).toBeTruthy()
    expect(screen.getByText('Legacy API Token')).toBeTruthy()
    expect(screen.getByText('Internal Service Key')).toBeTruthy()
    expect(screen.getByText(/Showing 3 of 3 credentials/i)).toBeTruthy()
  })

  it('hides create and import actions for viewers', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer' as const,
          credentials: {
            items: [makeCredential()],
            total: 1,
            page: 1,
            limit: 20,
            hasNext: false,
          },
          filters: { q: '', status: '', page: 1 },
        },
      },
    })

    expect(screen.queryByText('Add credential')).toBeNull()
    expect(screen.queryByText('Import')).toBeNull()
  })

  it('create form clears value input after submit', async () => {
    createCredentialMock.mockResolvedValue({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      name: 'New DB Password',
    })

    render(CreateCredentialPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
        },
      },
    })

    await fireEvent.input(screen.getByLabelText('Name'), {
      target: { value: 'New DB Password' },
    })
    const valueInput = screen.getByLabelText('Value') as HTMLInputElement
    await fireEvent.input(valueInput, { target: { value: 's3cret!' } })
    await fireEvent.click(screen.getByRole('button', { name: /Create credential/i }))

    await waitFor(() => expect(createCredentialMock).toHaveBeenCalled())
    expect(valueInput.value).toBe('')
    expect(gotoMock).toHaveBeenCalledWith(
      `/projects/${projectId}/credentials/ffffffff-ffff-4fff-8fff-ffffffffffff`
    )
  })

  it('detail reveal never writes credential value to browser storage', async () => {
    revealCredentialValueMock.mockResolvedValue({
      value: 'sk_live_super_secret',
      versionNumber: 1,
      retrievedAt: '2026-06-29T12:00:00.000Z',
    })

    const { unmount } = render(CredentialDetailPage, {
      props: {
        data: {
          projectId,
          credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          orgRole: 'member' as const,
          credential: {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            projectId,
            orgId: '11111111-1111-4111-8111-111111111111',
            name: 'Stripe Secret Key',
            description: null,
            tags: [],
            expiresAt: '2026-07-15T00:00:00.000Z',
            rotationSchedule: null,
            retentionCount: 5,
            currentVersionNumber: 1,
            createdBy: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
          versions: [],
        },
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /Reveal value/i }))
    await waitFor(() => expect(screen.getByText('sk_live_super_secret')).toBeTruthy())

    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(sessionStorage.setItem).not.toHaveBeenCalled()
    expect(localStorage.getItem('sk_live_super_secret')).toBeNull()
    expect(sessionStorage.getItem('sk_live_super_secret')).toBeNull()

    unmount()
  })

  it('import preview and confirm flow shows redacted values then summary', async () => {
    previewCredentialImportMock.mockResolvedValue({
      importId: '11111111-1111-4111-8111-111111111111',
      expiresAt: '2026-06-29T12:15:00.000Z',
      itemCount: 2,
      parsed: [
        {
          name: 'STRIPE_SECRET_KEY',
          value: '[REDACTED]',
          conflictsWith: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          conflictName: 'Stripe Secret Key',
          suggestedAction: 'new_version',
        },
        {
          name: 'NEW_KEY',
          value: '[REDACTED]',
          conflictsWith: null,
          conflictName: null,
          suggestedAction: 'create_new',
        },
      ],
      warnings: [],
    })
    confirmCredentialImportMock.mockResolvedValue({
      imported: 2,
      newVersions: 1,
      skipped: 0,
      results: [],
    })

    render(ImportCredentialsPage, {
      props: {
        data: {
          projectId,
          orgRole: 'admin' as const,
          canImport: true,
        },
      },
    })

    const file = new File(['STRIPE_SECRET_KEY=x\nNEW_KEY=y'], 'secrets.env', { type: 'text/plain' })
    const input = screen.getByLabelText(/Select .env or JSON file/i) as HTMLInputElement
    await fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(previewCredentialImportMock).toHaveBeenCalled())
    expect(await screen.findByText('STRIPE_SECRET_KEY')).toBeTruthy()
    expect(screen.getAllByText('[REDACTED]').length).toBeGreaterThan(0)
    expect(screen.getByText('Stripe Secret Key')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /Confirm import/i }))

    await waitFor(() => expect(confirmCredentialImportMock).toHaveBeenCalled())
    expect(await screen.findByText(/Import complete/i)).toBeTruthy()
    expect(screen.getByText(/Imported: 2/i)).toBeTruthy()
  })

  it('import page shows forbidden message for members', () => {
    render(ImportCredentialsPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          canImport: false,
        },
      },
    })

    expect(screen.getByText(/Import not available/i)).toBeTruthy()
    expect(screen.queryByLabelText(/Select .env or JSON file/i)).toBeNull()
  })
})
