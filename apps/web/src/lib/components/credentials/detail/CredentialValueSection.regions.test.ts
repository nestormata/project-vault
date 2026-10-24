import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { credentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
import { sampleCredential, sampleProject } from '$lib/test/fixtures.js'

// Story 69-14: the Secret value section's sub-regions. A probe contribution lands BETWEEN the two PV
// sections it was meant to sit between, the section keeps ONE owner of the display-once state across
// its sub-regions, and nothing typed or revealed ever reaches a contribution.

const revealMock = vi.hoisted(() => vi.fn())
const addVersionMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]' },
    params: {},
  },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => undefined) }))
vi.mock('$lib/api/credentials.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/credentials.js')>('$lib/api/credentials.js')
  return {
    parseRevealedFields: actual.parseRevealedFields,
    isFieldsValue: actual.isFieldsValue,
    revealCredentialValue: revealMock,
    addCredentialVersion: addVersionMock,
  }
})

const POINTS = [
  'credential.detail.value',
  'credential.detail.value-fields',
  'credential.detail.value-single',
  'credential.detail.value-copy-status',
  'credential.detail.value-edit-fields',
  'credential.detail.value-add-version',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const otherCredentialId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LEGACY = sampleCredential({ id: credentialId, projectId })
const MULTI = sampleCredential({
  id: credentialId,
  projectId,
  fields: [
    { key: 'host', sensitive: false },
    { key: 'password', sensitive: true },
  ],
  visibleFieldValues: { host: 'db.internal.example' },
})
const REVEALED = 'LEGACY-REVEALED-FIXTURE'

let Section: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Section = (await import('./CredentialValueSection.svelte')).default as unknown as typeof Section
}, 60_000)
beforeEach(() => {
  revealMock.mockReset()
  addVersionMock.mockReset()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
})
afterEach(() => cleanup())

function propsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    credential: LEGACY,
    projectId,
    credentialId,
    orgRole: 'member' as const,
    project: sampleProject({ id: projectId, role: 'member' }),
  }
  const merged = { ...base, ...overrides } as typeof base
  return {
    ...merged,
    pointProps: credentialPointExtras(merged),
    data: fills,
  }
}
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Section, { props: propsFor(overrides) })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = (point: string): number =>
  screen.queryAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
    .length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })
const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })

describe('CredentialValueSection sub-regions (probe order)', () => {
  it('single-field secret: single, copy status and add version sit between their PV sections', () => {
    mount()
    const single = probe('credential.detail.value-single')
    expect(follows(button('Reveal value'), single)).toBe(true)
    expect(follows(single, probe('credential.detail.value-copy-status'))).toBe(true)
    expect(follows(probe('credential.detail.value-copy-status'), heading('Add new version'))).toBe(
      true
    )
    const addVersion = probe('credential.detail.value-add-version')
    expect(follows(button('Add version'), addVersion)).toBe(true)
    expect(addVersion.closest('form')).not.toBeNull()
    expect(follows(addVersion, probe('credential.detail.value'))).toBe(true)
    expect(probeCount('credential.detail.value-fields')).toBe(0)
    expect(probeCount('credential.detail.value-edit-fields')).toBe(0)
  })

  it('multi-field secret: fields before the editor, the editor before the section point', () => {
    mount({ credential: MULTI })
    const fieldsProbe = probe('credential.detail.value-fields')
    expect(follows(button('Reveal all'), fieldsProbe)).toBe(true)
    expect(follows(fieldsProbe, heading('Edit fields'))).toBe(true)
    const edit = probe('credential.detail.value-edit-fields')
    expect(follows(button('Edit fields'), edit)).toBe(true)
    expect(follows(edit, probe('credential.detail.value'))).toBe(true)
    expect(probeCount('credential.detail.value-single')).toBe(0)
    expect(probeCount('credential.detail.value-add-version')).toBe(0)
  })

  it('a project viewer sees the field list region but no actionable sub-region', () => {
    mount({
      credential: MULTI,
      orgRole: 'viewer',
      project: sampleProject({ id: projectId, role: 'viewer' }),
    })
    expect(probeCount('credential.detail.value-fields')).toBe(1)
    expect(screen.queryByRole('button', { name: 'Reveal all' })).toBeNull()
    for (const point of [
      'credential.detail.value-single',
      'credential.detail.value-copy-status',
      'credential.detail.value-edit-fields',
      'credential.detail.value-add-version',
    ]) {
      expect(probeCount(point)).toBe(0)
    }
    expect(
      follows(screen.getByText(/requires Member access/), probe('credential.detail.value'))
    ).toBe(true)
  })

  it('a viewer of a single-field secret gets only the section point', () => {
    mount({ orgRole: 'viewer', project: sampleProject({ id: projectId, role: 'viewer' }) })
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
    expect(probeCount('credential.detail.value')).toBe(1)
  })
})

describe('CredentialValueSection state (one owner across sub-regions)', () => {
  it('reveals the single value, shows the version, hides it again, and never hands it to a point', async () => {
    revealMock.mockResolvedValue({ value: REVEALED, versionNumber: 3 })
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(REVEALED)).toBeTruthy())
    expect(screen.getByText('Version 3')).toBeTruthy()
    expect(follows(screen.getByText(REVEALED), probe('credential.detail.value-single'))).toBe(true)
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain(REVEALED)
    }
    await fireEvent.click(button('Hide'))
    expect(screen.queryByText(REVEALED)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reveal value' })).toBeTruthy()
  })

  it('shows a reveal failure inside the single region, before its point', async () => {
    revealMock.mockRejectedValue(
      new ApiClientError(403, { code: 'insufficient_project_role' }, 'no')
    )
    mount()
    await fireEvent.click(button('Reveal value'))
    const alert = await screen.findByText(/does not permit revealing secret values/)
    expect(follows(alert, probe('credential.detail.value-single'))).toBe(true)
  })

  it('clears a revealed value when the section is reused for another credential', async () => {
    revealMock.mockResolvedValue({ value: REVEALED, versionNumber: 3 })
    const view = mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(REVEALED)).toBeTruthy())
    await view.rerender(propsFor({ credentialId: otherCredentialId }))
    expect(screen.queryByText(REVEALED)).toBeNull()
    expect(screen.getByRole('button', { name: 'Reveal value' })).toBeTruthy()
  })

  it('announces a copy status in the copy-status region, between the reveal area and the form', async () => {
    revealMock.mockResolvedValue({ value: REVEALED, versionNumber: 3 })
    mount()
    await fireEvent.click(button(/copy/i))
    const status = await screen.findByRole('status')
    expect(status.textContent).not.toContain(REVEALED)
    expect(follows(probe('credential.detail.value-single'), status)).toBe(true)
    expect(follows(status, probe('credential.detail.value-copy-status'))).toBe(true)
    expect(follows(probe('credential.detail.value-copy-status'), heading('Add new version'))).toBe(
      true
    )
  })

  it('shares the copy-status list between a per-field copy and the section', async () => {
    revealMock.mockResolvedValue({
      fields: [{ key: 'password', sensitive: true, value: 'FIELD-REVEALED' }],
      versionNumber: 2,
    })
    mount({ credential: MULTI })
    await fireEvent.click(
      within(screen.getByTestId('field-row-password')).getByRole('button', { name: /copy/i })
    )
    const status = await screen.findByRole('status')
    expect(follows(status, probe('credential.detail.value-copy-status'))).toBe(true)
    expect(screen.getByTestId('field-masked-password')).toBeTruthy()
  })

  it('keeps a revealed field across opening and cancelling the field-set editor', async () => {
    revealMock.mockImplementation(async (_f: unknown, _p: string, _c: string, opts?: object) =>
      opts && 'field' in opts
        ? {
            fields: [{ key: 'password', sensitive: true, value: 'FIELD-REVEALED' }],
            versionNumber: 2,
          }
        : {
            fields: [
              { key: 'host', sensitive: false, value: 'db.internal.example' },
              { key: 'password', sensitive: true, value: 'FIELD-REVEALED' },
            ],
            versionNumber: 2,
          }
    )
    mount({ credential: MULTI })
    await fireEvent.click(
      within(screen.getByTestId('field-row-password')).getByRole('button', { name: 'Reveal' })
    )
    await waitFor(() => expect(screen.getByTestId('field-value-password')).toBeTruthy())

    await fireEvent.click(button('Edit fields'))
    await waitFor(() => expect(button('Save fields')).toBeTruthy())
    expect(screen.queryByTestId('field-list')).toBeNull()
    expect(probeCount('credential.detail.value-fields')).toBe(0)
    const form = button('Save fields').closest('form') as HTMLFormElement
    expect(follows(form, probe('credential.detail.value-edit-fields'))).toBe(true)
    expect((screen.getByLabelText('Field 2 value') as HTMLInputElement).value).toBe(
      'FIELD-REVEALED'
    )

    await fireEvent.click(button('Cancel'))
    expect(screen.getByTestId('field-value-password').textContent).toBe('FIELD-REVEALED')
    expect(probeCount('credential.detail.value-fields')).toBe(1)
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain('FIELD-REVEALED')
    }
  })

  it('keeps the typed version, shows the conflict error and resets after a clean save', async () => {
    mount()
    await fireEvent.click(button('Add version'))
    expect(screen.getByText('Value is required')).toBeTruthy()

    const input = screen.getByLabelText('New value') as HTMLTextAreaElement
    await fireEvent.input(input, { target: { value: 'typed-next-value' } })
    addVersionMock.mockRejectedValueOnce(new ApiClientError(409, { code: 'version_conflict' }, 'x'))
    await fireEvent.click(button('Add version'))
    await screen.findByText(/Someone just added a version/)
    expect(input.value).toBe('typed-next-value')
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain('typed-next-value')
    }

    addVersionMock.mockResolvedValueOnce({})
    await fireEvent.click(button('Add version'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('blocks both the add-version and the field-set save of an archived secret', async () => {
    mount({ credential: sampleCredential({ ...LEGACY, archivedAt: '2026-07-01T00:00:00.000Z' }) })
    expect((button('Add version') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    revealMock.mockResolvedValue({
      fields: [
        { key: 'host', sensitive: false, value: 'db.internal.example' },
        { key: 'password', sensitive: true, value: 'FIELD-REVEALED' },
      ],
      versionNumber: 2,
    })
    mount({ credential: sampleCredential({ ...MULTI, archivedAt: '2026-07-01T00:00:00.000Z' }) })
    await fireEvent.click(button('Edit fields'))
    await waitFor(() => expect(button('Save fields')).toBeTruthy())
    expect((button('Save fields') as HTMLButtonElement).disabled).toBe(true)
  })
})
