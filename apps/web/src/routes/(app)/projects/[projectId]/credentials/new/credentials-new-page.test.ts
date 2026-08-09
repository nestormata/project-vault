import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const createCredentialMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$lib/api/credentials.js', () => ({ createCredential: createCredentialMock }))

import { ApiClientError } from '$lib/api/client.js'
import NewCredentialPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function data(overrides: Record<string, unknown> = {}) {
  return { projectId, orgRole: 'member', ...overrides }
}

async function selectTemplate(value: string) {
  const select = screen.getByLabelText('Template') as HTMLSelectElement
  await fireEvent.change(select, { target: { value } })
}

describe('new credential +page.svelte (Story 13.2)', () => {
  it('shows the single value input when no template is selected (AC-5)', () => {
    render(NewCredentialPage, { props: { data: data() } })
    expect(screen.getByLabelText('Value')).toBeTruthy()
    expect(screen.queryByLabelText('Field 1 name')).toBeNull()
  })

  it('selecting Login pre-populates username and password fields (AC-1)', async () => {
    render(NewCredentialPage, { props: { data: data() } })
    await selectTemplate('login')
    expect((screen.getByLabelText('Field 1 name') as HTMLInputElement).value).toBe('username')
    expect((screen.getByLabelText('Field 2 name') as HTMLInputElement).value).toBe('password')
    // the single-value input is gone once a template is chosen
    expect(screen.queryByLabelText('Value')).toBeNull()
  })

  it('uses a textarea for the Secure Note value', async () => {
    render(NewCredentialPage, { props: { data: data() } })
    await selectTemplate('secure_note')

    expect(screen.getByLabelText('Field 1 value', { selector: 'textarea' })).toBeTruthy()
    expect(screen.queryByLabelText('Field 1 value', { selector: 'input' })).toBeNull()
  })

  it('selecting Custom starts empty and can add a field', async () => {
    render(NewCredentialPage, { props: { data: data() } })
    await selectTemplate('custom')
    expect(screen.queryByLabelText('Field 1 name')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: /add field/i }))
    expect(screen.getByLabelText('Field 1 name')).toBeTruthy()
  })

  it('can remove a field', async () => {
    render(NewCredentialPage, { props: { data: data() } })
    await selectTemplate('login')
    await fireEvent.click(screen.getByRole('button', { name: /remove field 1/i }))
    expect((screen.getByLabelText('Field 1 name') as HTMLInputElement).value).toBe('password')
  })

  it('submits a field-set create body with the chosen template (AC-2)', async () => {
    createCredentialMock.mockResolvedValue({ id: 'cred-1' })
    render(NewCredentialPage, { props: { data: data() } })
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'DB Login' } })
    await selectTemplate('login')
    await fireEvent.input(screen.getByLabelText('Field 1 value'), { target: { value: 'alice' } })
    await fireEvent.input(screen.getByLabelText('Field 2 value'), { target: { value: 'pw' } })
    await fireEvent.click(screen.getByRole('button', { name: /create credential/i }))

    expect(createCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      expect.objectContaining({
        name: 'DB Login',
        template: 'login',
        fields: [
          { key: 'username', value: 'alice', sensitive: false },
          { key: 'password', value: 'pw', sensitive: true },
        ],
      })
    )
    await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it.each([
    [
      'login',
      [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
      ],
    ],
    [
      'db_connection',
      [
        { key: 'host', value: 'db.example', sensitive: false },
        { key: 'port', value: '5432', sensitive: false },
        { key: 'database', value: 'vault', sensitive: false },
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 'pw', sensitive: true },
      ],
    ],
    ['api_key', [{ key: 'key', value: 'sk_live', sensitive: true }]],
    ['secure_note', [{ key: 'note', value: 'keep this safe', sensitive: true }]],
  ] as const)(
    'submits a valid %s template through the shared create path',
    async (template, values) => {
      createCredentialMock.mockResolvedValue({ id: 'cred-1' })
      render(NewCredentialPage, { props: { data: data() } })
      await fireEvent.input(screen.getByLabelText('Name'), {
        target: { value: `${template} credential` },
      })
      await selectTemplate(template)

      for (const [index, field] of values.entries()) {
        await fireEvent.input(screen.getByLabelText(`Field ${index + 1} value`), {
          target: { value: field.value },
        })
      }
      await fireEvent.click(screen.getByRole('button', { name: /create credential/i }))

      expect(createCredentialMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        expect.objectContaining({ template, fields: values })
      )
      await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
    }
  )

  it('submits multiple Custom fields without treating the field set as a single access token value', async () => {
    createCredentialMock.mockResolvedValue({ id: 'cred-custom' })
    render(NewCredentialPage, { props: { data: data() } })
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Custom credential' } })
    await selectTemplate('custom')
    await fireEvent.click(screen.getByRole('button', { name: /add field/i }))
    await fireEvent.click(screen.getByRole('button', { name: /add field/i }))
    await fireEvent.input(screen.getByLabelText('Field 1 name'), {
      target: { value: 'access-token' },
    })
    await fireEvent.input(screen.getByLabelText('Field 1 value'), { target: { value: 'token' } })
    await fireEvent.input(screen.getByLabelText('Field 2 name'), { target: { value: 'region' } })
    await fireEvent.input(screen.getByLabelText('Field 2 value'), {
      target: { value: 'us-east-1' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /create credential/i }))

    expect(createCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      expect.objectContaining({
        template: 'custom',
        fields: [
          { key: 'access-token', value: 'token', sensitive: false },
          { key: 'region', value: 'us-east-1', sensitive: false },
        ],
      })
    )
    await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  it('shows an inline error on the colliding field for a 409 field_key_conflict (AC-3)', async () => {
    createCredentialMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'field_key_conflict' },
        'A field named "password" already exists on this secret'
      )
    )
    render(NewCredentialPage, { props: { data: data() } })
    await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Dup' } })
    await selectTemplate('login')
    await fireEvent.input(screen.getByLabelText('Field 1 value'), { target: { value: 'a' } })
    await fireEvent.input(screen.getByLabelText('Field 2 value'), { target: { value: 'b' } })
    await fireEvent.click(screen.getByRole('button', { name: /create credential/i }))

    await vi.waitFor(() => {
      expect(screen.getAllByText(/already exists/i).length).toBeGreaterThan(0)
    })
  })
})
