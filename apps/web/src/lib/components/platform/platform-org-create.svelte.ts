import { ApiClientError } from '$lib/api/client.js'
import { createOrg, listOrgs, type OrgListItem } from '$lib/api/platform.js'

type CreateFailure = {
  error: string | null
  mfaError: string | null
  nameError: string | null
}

function sealedOrMessage(err: ApiClientError): string {
  const body = err.body as { status?: string; message?: string } | null
  if (body && 'status' in body && !('code' in body)) {
    return 'The vault was sealed while you were on this page — unseal it to continue.'
  }
  return err.message ?? 'Service unavailable'
}

const NONE: CreateFailure = { error: null, mfaError: null, nameError: null }

function mapApiFailure(err: ApiClientError): CreateFailure {
  const message = err.message
  if (err.status === 403 && err.code === 'mfa_required') {
    return { ...NONE, mfaError: message ?? 'MFA required' }
  }
  if (err.status === 409 && err.code === 'org_name_taken') {
    return { ...NONE, nameError: message ?? 'An organization with that name already exists.' }
  }
  if (err.status === 409 && err.code === 'max_orgs_reached') {
    const limit = `This instance has reached its maximum organizations. Increase the limit in Settings.`
    return { ...NONE, error: message ?? limit }
  }
  return { ...NONE, error: statusMessage(err) }
}

function statusMessage(err: ApiClientError): string {
  if (err.status === 422) return err.message ?? 'Validation failed'
  if (err.status === 503) return sealedOrMessage(err)
  return err.message ?? 'Failed to create organization'
}

function createFailure(err: unknown): CreateFailure {
  if (!(err instanceof ApiClientError)) return { ...NONE, error: 'Failed to create organization' }
  return mapApiFailure(err)
}

/**
 * Story 69.11: the one owner of the create-organization form state (typed values, busy flag, status
 * and error banners), created by `PlatformOrgsContent` and handed to the status and form regions.
 * `onCreated` receives the refreshed organization list after a successful create.
 */
export class PlatformOrgCreate {
  newOrgName = $state('')
  newOrgOwnerEmail = $state('')
  createError = $state<string | null>(null)
  createMfaError = $state<string | null>(null)
  createNameError = $state<string | null>(null)
  createSuccess = $state<string | null>(null)
  creating = $state(false)
  readonly #onCreated: (orgs: OrgListItem[]) => void

  constructor(onCreated: (orgs: OrgListItem[]) => void) {
    this.#onCreated = onCreated
  }

  async submit(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    this.creating = true
    this.createError = null
    this.createMfaError = null
    this.createNameError = null
    this.createSuccess = null

    try {
      const ownerEmail = this.newOrgOwnerEmail.trim()
      const result = await createOrg(fetch, { name: this.newOrgName.trim(), ownerEmail })
      this.createSuccess =
        result.ownerAccountAction === 'existing_user_added'
          ? `Organization "${result.name}" created. ${ownerEmail} was added as owner (existing account).`
          : `Organization "${result.name}" created. An invitation was sent to ${ownerEmail}.`
      this.newOrgName = ''
      this.newOrgOwnerEmail = ''
      const refreshed = await listOrgs(fetch)
      this.#onCreated(refreshed.items)
    } catch (err) {
      const failure = createFailure(err)
      this.createError = failure.error
      this.createMfaError = failure.mfaError
      this.createNameError = failure.nameError
    } finally {
      this.creating = false
    }
  }
}
