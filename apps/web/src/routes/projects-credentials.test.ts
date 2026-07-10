import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { formatDateTime } from '$lib/datetime.js'
import { ApiClientError } from '$lib/api/client.js'
import type { CredentialSummary } from '@project-vault/shared'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const createCredentialMock = vi.hoisted(() => vi.fn())
const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const previewCredentialImportMock = vi.hoisted(() => vi.fn())
const confirmCredentialImportMock = vi.hoisted(() => vi.fn())
const updateCredentialLifecycleMock = vi.hoisted(() => vi.fn())
const addCredentialDependencyMock = vi.hoisted(() => vi.fn())
const archiveCredentialDependencyMock = vi.hoisted(() => vi.fn())
const addCredentialVersionMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
  invalidateAll: invalidateAllMock,
}))

vi.mock('$lib/api/credentials.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/api/credentials.js')>()
  return {
    ...original,
    createCredential: createCredentialMock,
    revealCredentialValue: revealCredentialValueMock,
    previewCredentialImport: previewCredentialImportMock,
    confirmCredentialImport: confirmCredentialImportMock,
    updateCredentialLifecycle: updateCredentialLifecycleMock,
    addCredentialDependency: addCredentialDependencyMock,
    archiveCredentialDependency: archiveCredentialDependencyMock,
    addCredentialVersion: addCredentialVersionMock,
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
    expiresAt: overrides.expiresAt === undefined ? '2026-07-15T00:00:00.000Z' : overrides.expiresAt,
    rotationSchedule: null,
    currentVersionNumber: 1,
    hasDependencies: overrides.hasDependencies ?? false,
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
    updateCredentialLifecycleMock.mockReset()
    addCredentialDependencyMock.mockReset()
    archiveCredentialDependencyMock.mockReset()
    addCredentialVersionMock.mockReset()
    invalidateAllMock.mockClear()
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
          filters: { q: '', status: '', tags: '', page: 1 },
        },
      },
    })

    expect(screen.getByText('Stripe Secret Key')).toBeTruthy()
    expect(screen.getByText('Legacy API Token')).toBeTruthy()
    expect(screen.getByText('Internal Service Key')).toBeTruthy()
    expect(screen.getByText(/Showing 3 of 3 credentials/i)).toBeTruthy()
  })

  it('AC-F1: renders a Tags filter input pre-filled from data.filters.tags, with AND-semantics helper text', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', tags: 'db, prod', page: 1 },
        },
      },
    })

    const tagsInput = screen.getByLabelText('Tags') as HTMLInputElement
    expect(tagsInput.value).toBe('db, prod')
    expect(screen.getByText(/Matches credentials with ALL of these tags/i)).toBeTruthy()
  })

  it('AC-F2: a tags-only filter with zero results shows "Try adjusting your filters." and a Clear link', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', tags: 'nonexistent', page: 1 },
        },
      },
    })

    expect(screen.getByText('No credentials found')).toBeTruthy()
    expect(screen.getByText('Try adjusting your filters.')).toBeTruthy()
    const clearLink = screen.getByRole('link', { name: 'Clear' })
    expect(clearLink.getAttribute('href')).toBe(`/projects/${projectId}/credentials`)
  })

  it('regression: q/status-only empty-state and Clear-link behavior is unchanged', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: 'nope', status: '', tags: '', page: 1 },
        },
      },
    })

    expect(screen.getByText('Try adjusting your filters.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Clear' })).toBeTruthy()
  })

  it('regression: no filters at all and zero credentials shows the "Add your first credential" copy, not the filtered empty state', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'member' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', tags: '', page: 1 },
        },
      },
    })

    expect(screen.getByText('Add your first credential to get started.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Clear' })).toBeNull()
  })

  it('shows the read-only empty copy to viewers and the access-safe not-found banner', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', tags: '', page: 1 },
        },
      },
    })
    expect(screen.getByText(/no credentials have been added/i)).toBeTruthy()
    cleanup()
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'admin' as const,
          notFound: true,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', tags: '', page: 1 },
        },
      },
    })
    expect(screen.getByRole('alert').textContent).toMatch(/not found or you do not have access/i)
    expect(screen.queryByRole('button', { name: /apply filters/i })).toBeNull()
  })

  it('renders dependency and no-tag/no-expiry table branches', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'admin' as const,
          credentials: {
            items: [
              makeCredential({
                tags: [],
                expiresAt: null,
                hasDependencies: true,
              }),
            ],
            total: 1,
            page: 1,
            limit: 20,
            hasNext: false,
          },
          filters: { q: '', status: '', tags: '', page: 1 },
        },
      },
    })
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('link', { name: /add credential/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /^import$/i })).toBeTruthy()
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

  it('AC-A1: sub-nav gains Services/Certificates/Domains/Endpoints links resolving to real routes', () => {
    render(CredentialsListPage, {
      props: {
        data: {
          projectId,
          orgRole: 'viewer' as const,
          credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
          filters: { q: '', status: '', page: 1 },
        },
      },
    })

    expect(screen.getByRole('link', { name: 'Services' }).getAttribute('href')).toBe(
      `/projects/${projectId}/services`
    )
    expect(screen.getByRole('link', { name: 'Certificates' }).getAttribute('href')).toBe(
      `/projects/${projectId}/certificates`
    )
    expect(screen.getByRole('link', { name: 'Domains' }).getAttribute('href')).toBe(
      `/projects/${projectId}/domains`
    )
    expect(screen.getByRole('link', { name: 'Endpoints' }).getAttribute('href')).toBe(
      `/projects/${projectId}/service-endpoints`
    )
    // Pre-existing links must still be present, unmodified.
    expect(screen.getByRole('link', { name: 'Members' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Public status page' })).toBeTruthy()
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
            cacheable: true,
            retentionCount: 5,
            currentVersionNumber: 1,
            createdBy: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
          versions: [],
          dependencies: { items: [], hasDependencies: false },
          rotations: [],
          rotationsPage: 1,
          rotationsHasMore: false,
          activeRotationId: null,
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

  it('AC-P7: reveal 403 with code insufficient_project_role shows the project-role-specific message', async () => {
    revealCredentialValueMock.mockRejectedValue(
      new ApiClientError(
        403,
        {
          code: 'insufficient_project_role',
          message: 'Your role in this project does not permit revealing credential values',
        },
        'Your role in this project does not permit revealing credential values'
      )
    )

    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({ orgRole: 'member' as const }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /Reveal value/i }))

    expect(
      await screen.findByText(
        /Your role in this project does not permit revealing credential values/i
      )
    ).toBeTruthy()
    expect(screen.queryByText('You do not have permission to reveal credential values.')).toBeNull()
  })

  it('AC-P7 regression: a plain 403 with no specific code still shows the generic denial message', async () => {
    revealCredentialValueMock.mockRejectedValue(
      new ApiClientError(403, { message: 'Forbidden' }, 'Forbidden')
    )

    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({ orgRole: 'member' as const }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /Reveal value/i }))

    expect(
      await screen.findByText('You do not have permission to reveal credential values.')
    ).toBeTruthy()
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

  it.each([
    [
      new ApiClientError(413, { code: 'import_too_large', message: 'too large' }, 'too large'),
      /maximum size is 1 mb/i,
    ],
    [
      new ApiClientError(422, { code: 'invalid_import', message: 'Invalid file' }, 'Invalid file'),
      /invalid file/i,
    ],
    [new Error('preview offline'), /preview offline/i],
    [{ reason: 'unknown' }, /import preview failed/i],
  ])('maps import-preview failures and clears the file control', async (failure, expected) => {
    previewCredentialImportMock.mockRejectedValue(failure)
    render(ImportCredentialsPage, {
      props: { data: { projectId, orgRole: 'admin' as const, canImport: true } },
    })
    const file = new File(['KEY=value'], 'secrets.env', { type: 'text/plain' })
    const input = screen.getByLabelText(/select .env or json file/i) as HTMLInputElement
    await fireEvent.change(input, { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    expect(input.value).toBe('')
  })

  it('returns from preview to upload without confirming', async () => {
    previewCredentialImportMock.mockResolvedValue({
      importId: 'import-1',
      expiresAt: '2026-07-10T12:00:00Z',
      itemCount: 1,
      parsed: [
        {
          name: 'KEY',
          value: '[REDACTED]',
          conflictsWith: null,
          conflictName: null,
          suggestedAction: 'create_new',
        },
      ],
      warnings: [],
    })
    render(ImportCredentialsPage, {
      props: { data: { projectId, orgRole: 'admin' as const, canImport: true } },
    })
    const file = new File(['KEY=value'], 'secrets.env', { type: 'text/plain' })
    await fireEvent.change(screen.getByLabelText(/select .env or json file/i), {
      target: { files: [file] },
    })
    await fireEvent.click(await screen.findByRole('button', { name: /upload different file/i }))
    expect(screen.getByLabelText(/select .env or json file/i)).toBeTruthy()
    expect(confirmCredentialImportMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      new ApiClientError(410, { code: 'import_expired', message: 'expired' }, 'expired'),
      /preview expired/i,
      true,
    ],
    [
      new ApiClientError(404, { code: 'import_not_found', message: 'missing' }, 'missing'),
      /preview expired/i,
      true,
    ],
    [
      new ApiClientError(
        422,
        { code: 'invalid_import', message: 'Invalid import' },
        'Invalid import'
      ),
      /invalid import/i,
      false,
    ],
    [new Error('confirm offline'), /confirm offline/i, false],
    [{ reason: 'unknown' }, /import confirm failed/i, false],
  ])('maps import-confirm failures', async (failure, expected, returnsToUpload) => {
    previewCredentialImportMock.mockResolvedValue({
      importId: 'import-1',
      expiresAt: '2026-07-10T12:00:00Z',
      itemCount: 1,
      parsed: [
        {
          name: 'KEY',
          value: '[REDACTED]',
          conflictsWith: null,
          conflictName: null,
          suggestedAction: 'create_new',
        },
      ],
      warnings: [],
    })
    confirmCredentialImportMock.mockRejectedValue(failure)
    render(ImportCredentialsPage, {
      props: { data: { projectId, orgRole: 'admin' as const, canImport: true } },
    })
    const file = new File(['KEY=value'], 'secrets.env', { type: 'text/plain' })
    await fireEvent.change(screen.getByLabelText(/select .env or json file/i), {
      target: { files: [file] },
    })
    await fireEvent.click(await screen.findByRole('button', { name: /confirm import/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(expected)
    if (returnsToUpload) {
      expect(screen.getByLabelText(/select .env or json file/i)).toBeTruthy()
    } else {
      expect(screen.getByRole('button', { name: /confirm import/i })).toBeTruthy()
    }
  })

  it('validates create fields, maps errors, and preserves optional payload branches', async () => {
    createCredentialMock.mockRejectedValueOnce(
      new ApiClientError(
        422,
        { message: 'Invalid', details: { name: ['Name already exists'] } },
        'Invalid'
      )
    )
    render(CreateCredentialPage, {
      props: { data: { projectId, orgRole: 'member' as const } },
    })
    const createButton = screen.getByRole('button', { name: /create credential/i })
    await fireEvent.submit(createButton.closest('form') as HTMLFormElement)
    expect(await screen.findByText(/name is required/i)).toBeTruthy()
    expect(screen.getByText(/credential value cannot be empty/i)).toBeTruthy()
    expect(createCredentialMock).not.toHaveBeenCalled()

    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: '  API Key  ' } })
    await fireEvent.input(screen.getByLabelText('Value'), { target: { value: 'secret' } })
    await fireEvent.input(screen.getByLabelText('Description'), {
      target: { value: '  Production key  ' },
    })
    await fireEvent.input(screen.getByLabelText('Tags'), { target: { value: 'prod, api' } })
    await fireEvent.submit(createButton.closest('form') as HTMLFormElement)
    expect(createCredentialMock).toHaveBeenCalledWith(expect.anything(), projectId, {
      name: 'API Key',
      value: 'secret',
      description: 'Production key',
      tags: ['prod', 'api'],
    })
    expect(await screen.findByText(/name already exists/i)).toBeTruthy()
  })

  it('renders create access notice for viewers', () => {
    render(CreateCredentialPage, {
      props: { data: { projectId, orgRole: 'viewer' as const } },
    })
    expect(screen.getByText(/create not available/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /create credential/i })).toBeNull()
  })

  function baseCredentialDetailData(overrides: Record<string, unknown> = {}) {
    return {
      projectId,
      credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      orgRole: 'admin' as const,
      credential: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        projectId,
        orgId: '11111111-1111-4111-8111-111111111111',
        name: 'Stripe Secret Key',
        description: null,
        tags: [],
        expiresAt: '2026-07-15T00:00:00.000Z',
        rotationSchedule: null,
        cacheable: true,
        retentionCount: 5,
        currentVersionNumber: 1,
        createdBy: null,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      versions: [],
      dependencies: { items: [], hasDependencies: false },
      rotations: [],
      rotationsPage: 1,
      rotationsHasMore: false,
      activeRotationId: null,
      ...overrides,
    }
  }

  function makeDependency(overrides: Record<string, unknown> = {}) {
    return {
      id: 'd1',
      credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      systemName: 'billing-worker',
      systemType: 'service',
      notes: null,
      createdBy: null,
      archivedAt: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('AC-1: admin sees "Start rotation" when there is no active rotation', () => {
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const link = screen.getByRole('link', { name: 'Start rotation' })
    expect(link.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc/rotate`
    )
  })

  it('AC-1: member/viewer sees explanatory text instead of a "Start rotation" link', () => {
    render(CredentialDetailPage, {
      props: { data: baseCredentialDetailData({ orgRole: 'member' as const }) },
    })

    expect(screen.queryByRole('link', { name: 'Start rotation' })).toBeNull()
    expect(screen.getByText('Starting a rotation requires Admin access or higher.')).toBeTruthy()
  })

  it('AC-1: brand-new credential with zero rotations shows the empty-state history message', () => {
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    expect(screen.getByText('No rotations yet.')).toBeTruthy()
  })

  it('AC-2: any role sees "View active rotation" (never "Start rotation") while one is active', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          orgRole: 'viewer' as const,
          activeRotationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        }),
      },
    })

    const link = screen.getByRole('link', { name: 'View active rotation' })
    expect(link.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc/rotations/dddddddd-dddd-4ddd-8ddd-dddddddddddd`
    )
    expect(screen.queryByRole('link', { name: 'Start rotation' })).toBeNull()
  })

  it('AC-L1: a member can edit expiresAt/rotationSchedule/cacheable and the read-only grid updates without reload', async () => {
    updateCredentialLifecycleMock.mockResolvedValue({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expiresAt: '2026-12-01T00:00:00.000Z',
      rotationSchedule: '0 0 1 * *',
      cacheable: true,
      updatedAt: '2026-07-02T00:00:00.000Z',
    })
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const expiresInput = screen.getByLabelText('Expiry date') as HTMLInputElement
    await fireEvent.input(expiresInput, { target: { value: '2026-12-01' } })
    const rotationInput = screen.getByLabelText('Rotation schedule (cron)') as HTMLInputElement
    await fireEvent.input(rotationInput, { target: { value: '0 0 1 * *' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    await waitFor(() =>
      expect(updateCredentialLifecycleMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { expiresAt: '2026-12-01T00:00:00.000Z', rotationSchedule: '0 0 1 * *', cacheable: true }
      )
    )

    expect(await screen.findByText(formatDateTime('2026-12-01T00:00:00.000Z'))).toBeTruthy()
  })

  it('AC-L1: cacheable checkbox is pre-filled from credential detail (not hardcoded true)', async () => {
    updateCredentialLifecycleMock.mockResolvedValue({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expiresAt: '2026-07-15T00:00:00.000Z',
      rotationSchedule: null,
      cacheable: false,
      updatedAt: '2026-07-02T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          credential: {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            projectId,
            orgId: '11111111-1111-4111-8111-111111111111',
            name: 'Stripe Secret Key',
            description: null,
            tags: [],
            expiresAt: '2026-07-15T00:00:00.000Z',
            rotationSchedule: null,
            cacheable: false,
            retentionCount: 5,
            currentVersionNumber: 1,
            createdBy: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        }),
      },
    })

    const cacheable = screen.getByLabelText('Cacheable by offline agents') as HTMLInputElement
    expect(cacheable.checked).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    await waitFor(() =>
      expect(updateCredentialLifecycleMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { expiresAt: '2026-07-15T00:00:00.000Z', rotationSchedule: null, cacheable: false }
      )
    )
  })

  it('AC-L1 edge: clearing the expiry date sends expiresAt: null and the grid reverts to "—"', async () => {
    updateCredentialLifecycleMock.mockResolvedValue({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expiresAt: null,
      rotationSchedule: null,
      cacheable: true,
      updatedAt: '2026-07-02T00:00:00.000Z',
    })
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const expiresInput = screen.getByLabelText('Expiry date') as HTMLInputElement
    await fireEvent.input(expiresInput, { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    await waitFor(() =>
      expect(updateCredentialLifecycleMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { expiresAt: null, rotationSchedule: null, cacheable: true }
      )
    )

    await waitFor(() => {
      expect(screen.getByText('Expires').nextElementSibling?.textContent).toBe('—')
    })
  })

  it('AC-L2: an invalid_cron 422 shows the exact server message inline under the input, without resetting it', async () => {
    updateCredentialLifecycleMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'invalid_cron', message: 'Rotation schedule may run at most once per hour' },
        'Rotation schedule may run at most once per hour'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const rotationInput = screen.getByLabelText('Rotation schedule (cron)') as HTMLInputElement
    await fireEvent.input(rotationInput, { target: { value: '* * * * *' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    expect(await screen.findByText('Rotation schedule may run at most once per hour')).toBeTruthy()
    expect(rotationInput.value).toBe('* * * * *')
  })

  it('AC-L2 edge: an unparseable cron shows "Invalid cron expression" verbatim', async () => {
    updateCredentialLifecycleMock.mockRejectedValue(
      new ApiClientError(
        422,
        { code: 'invalid_cron', message: 'Invalid cron expression' },
        'Invalid cron expression'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const rotationInput = screen.getByLabelText('Rotation schedule (cron)') as HTMLInputElement
    await fireEvent.input(rotationInput, { target: { value: 'not a cron' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    expect(await screen.findByText('Invalid cron expression')).toBeTruthy()
  })

  it('AC-L3: viewers see no Lifecycle edit section at all', () => {
    render(CredentialDetailPage, {
      props: { data: baseCredentialDetailData({ orgRole: 'viewer' as const }) },
    })

    expect(screen.queryByText('Lifecycle')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save lifecycle' })).toBeNull()
    expect(screen.queryByLabelText('Rotation schedule (cron)')).toBeNull()
  })

  it('AC-L4: an archived-project 410 on lifecycle save shows an inline banner and leaves the grid unchanged', async () => {
    updateCredentialLifecycleMock.mockRejectedValue(
      new ApiClientError(
        410,
        {
          code: 'project_archived',
          message: 'This project is archived and cannot be modified. Unarchive it first.',
        },
        'This project is archived and cannot be modified. Unarchive it first.'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))

    expect(
      await screen.findByText('This project is archived — unarchive it to make changes.')
    ).toBeTruthy()
    expect(screen.getByText(formatDateTime('2026-07-15T00:00:00.000Z'))).toBeTruthy()
  })

  it('AC-D1: a member can add a dependent system with the pre-selected default systemType sent explicitly', async () => {
    addCredentialDependencyMock.mockResolvedValue(makeDependency({ systemType: 'other' }))
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.input(screen.getByLabelText('System name'), {
      target: { value: 'billing-worker' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Add dependent system' }))

    await waitFor(() =>
      expect(addCredentialDependencyMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { systemName: 'billing-worker', systemType: 'other' }
      )
    )
    expect(await screen.findByText('billing-worker (other)')).toBeTruthy()
  })

  it('AC-D1 edge: selecting an explicit non-default systemType sends it and displays it on the new row', async () => {
    addCredentialDependencyMock.mockResolvedValue(
      makeDependency({ systemName: 'primary-db', systemType: 'database' })
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.input(screen.getByLabelText('System name'), {
      target: { value: 'primary-db' },
    })
    await fireEvent.change(screen.getByLabelText('System type'), {
      target: { value: 'database' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Add dependent system' }))

    await waitFor(() =>
      expect(addCredentialDependencyMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { systemName: 'primary-db', systemType: 'database' }
      )
    )
    expect(await screen.findByText('primary-db (database)')).toBeTruthy()
  })

  it('AC-D2: archiving the only dependency removes it and shows the empty state', async () => {
    archiveCredentialDependencyMock.mockResolvedValue({
      id: 'd1',
      credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      archivedAt: '2026-07-01T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          dependencies: { items: [makeDependency()], hasDependencies: true },
        }),
      },
    })

    expect(screen.getByText('billing-worker (service)')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() =>
      expect(archiveCredentialDependencyMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'd1'
      )
    )
    expect(await screen.findByText('No dependent systems recorded.')).toBeTruthy()
  })

  it('AC-D2 edge: archiving one of several dependencies leaves the others visible', async () => {
    archiveCredentialDependencyMock.mockResolvedValue({
      id: 'd1',
      credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      archivedAt: '2026-07-01T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          dependencies: {
            items: [
              makeDependency(),
              makeDependency({ id: 'd2', systemName: 'primary-db', systemType: 'database' }),
            ],
            hasDependencies: true,
          },
        }),
      },
    })

    const [firstArchiveButton] = screen.getAllByRole('button', { name: 'Archive' })
    await fireEvent.click(firstArchiveButton)

    await waitFor(() => expect(archiveCredentialDependencyMock).toHaveBeenCalled())
    expect(screen.queryByText('billing-worker (service)')).toBeNull()
    expect(screen.getByText('primary-db (database)')).toBeTruthy()
  })

  it('AC-D3: the 200-cap 422 renders the exact server message inline and retains the entered values', async () => {
    addCredentialDependencyMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'too_many_dependencies',
          message: 'A credential may have at most 200 active dependencies',
        },
        'A credential may have at most 200 active dependencies'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    const nameInput = screen.getByLabelText('System name') as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: 'one-too-many' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add dependent system' }))

    expect(
      await screen.findByText('A credential may have at most 200 active dependencies')
    ).toBeTruthy()
    expect(nameInput.value).toBe('one-too-many')
  })

  it('AC-D4: viewers see the dependent-systems list but not the add form or Archive buttons', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          orgRole: 'viewer' as const,
          dependencies: { items: [makeDependency()], hasDependencies: true },
        }),
      },
    })

    expect(screen.getByText('billing-worker (service)')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add dependent system' })).toBeNull()
    expect(screen.queryByLabelText('System name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it('AC-D5: an archived-project 410 on add-dependency shows an inline banner and leaves the list unchanged', async () => {
    addCredentialDependencyMock.mockRejectedValue(
      new ApiClientError(
        410,
        {
          code: 'project_archived',
          message: 'This project is archived and cannot be modified. Unarchive it first.',
        },
        'This project is archived and cannot be modified. Unarchive it first.'
      )
    )
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          dependencies: { items: [makeDependency()], hasDependencies: true },
        }),
      },
    })

    await fireEvent.input(screen.getByLabelText('System name'), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add dependent system' }))

    expect(
      await screen.findByText('This project is archived — unarchive it to make changes.')
    ).toBeTruthy()
    expect(screen.getByText('billing-worker (service)')).toBeTruthy()
  })

  it('AC-V1: a member can add a new version; the client function is called and the history re-fetches (not client-synthesized)', async () => {
    addCredentialVersionMock.mockResolvedValue({
      credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      versionNumber: 2,
      createdAt: '2026-07-01T00:00:00.000Z',
    })
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.input(screen.getByLabelText('New value'), {
      target: { value: 'sk_live_new_secret' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Add version' }))

    await waitFor(() =>
      expect(addCredentialVersionMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        { value: 'sk_live_new_secret' }
      )
    )
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
    // The submitted value is never echoed back anywhere in the DOM after a successful submit.
    expect(screen.queryByText('sk_live_new_secret')).toBeNull()
  })

  it('AC-V2: an empty value is blocked client-side before any network call', async () => {
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.click(screen.getByRole('button', { name: 'Add version' }))

    expect(await screen.findByText('Value is required')).toBeTruthy()
    expect(addCredentialVersionMock).not.toHaveBeenCalled()
  })

  it('AC-V2 edge: a 409 version_conflict shows an actionable retry message', async () => {
    addCredentialVersionMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'version_conflict', message: 'Version conflict' },
        'Version conflict'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add version' }))

    expect(
      await screen.findByText('Someone just added a version — refresh and try again.')
    ).toBeTruthy()
  })

  it('AC-V3: viewers do not see the add-version control at all', () => {
    render(CredentialDetailPage, {
      props: { data: baseCredentialDetailData({ orgRole: 'viewer' as const }) },
    })

    expect(screen.queryByLabelText('New value')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add version' })).toBeNull()
  })

  it('AC-V4: an archived-project 410 on add-version shows an inline banner and leaves history unchanged', async () => {
    addCredentialVersionMock.mockRejectedValue(
      new ApiClientError(
        410,
        {
          code: 'project_archived',
          message: 'This project is archived and cannot be modified. Unarchive it first.',
        },
        'This project is archived and cannot be modified. Unarchive it first.'
      )
    )
    render(CredentialDetailPage, { props: { data: baseCredentialDetailData() } })

    await fireEvent.input(screen.getByLabelText('New value'), { target: { value: 'sk_live_x' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Add version' }))

    expect(
      await screen.findByText('This project is archived — unarchive it to make changes.')
    ).toBeTruthy()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  it('AC-18: rotation history section lists prior rotations most-recent-first with a link to each', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          rotations: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              status: 'completed',
              initiatedBy: null,
              initiatedAt: '2026-06-01T09:00:00.000Z',
              completedAt: '2026-06-01T09:45:00.000Z',
              itemCount: 3,
              confirmedCount: 3,
            },
          ],
        }),
      },
    })

    expect(screen.getByText('3/3 confirmed', { exact: false })).toBeTruthy()
    const rotationLink = screen.getByRole('link', { name: /initiated/i })
    expect(rotationLink.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc/rotations/ffffffff-ffff-4fff-8fff-ffffffffffff`
    )
  })

  it('AC-18: shows a "Show more" link that appends ?page= when hasMore is true', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          rotations: [
            {
              id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              status: 'completed',
              initiatedBy: null,
              initiatedAt: '2026-06-01T09:00:00.000Z',
              completedAt: '2026-06-01T09:45:00.000Z',
              itemCount: 1,
              confirmedCount: 1,
            },
          ],
          rotationsPage: 1,
          rotationsHasMore: true,
        }),
      },
    })

    const showMore = screen.getByRole('link', { name: 'Show more' })
    expect(showMore.getAttribute('href')).toBe(
      `/projects/${projectId}/credentials/cccccccc-cccc-4ccc-8ccc-cccccccccccc?page=2`
    )
  })

  it('AC-1: renders the sealed-vault message (not "Credential not found") when data.vaultSealed is true', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseCredentialDetailData({
          vaultSealed: true as const,
          credential: null,
          notFound: false as const,
        }),
      },
    })

    expect(screen.getByRole('alert').textContent).toContain(onboardingCopy.vaultSealedMessage)
    expect(screen.queryByText('Credential not found')).toBeNull()
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
