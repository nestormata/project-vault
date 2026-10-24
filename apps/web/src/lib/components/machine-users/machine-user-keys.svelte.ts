import { SvelteMap } from 'svelte/reactivity'
import { invalidateAll } from '$app/navigation'
import {
  emergencyRevokeApiKey,
  issueApiKey,
  revokeApiKey,
  rotateApiKey,
} from '$lib/api/machine-users.js'
import { apiErrorMessage } from './machine-user-detail.js'

const DEFAULT_OVERLAP_MINUTES = 240

/**
 * Story 69.14: the one owner of the API key state of the machine user detail. The plaintext key is
 * shown exactly once, from issue, rotate (the new key) or emergency-revoke (the new key), and is
 * never re-fetchable afterwards: it is ephemeral, never persisted to or re-derived from the server
 * load data. The reveal, issue and key list regions all read and write this one object.
 */
export class MachineUserKeys {
  revealedKey = $state<{ label: string; value: string } | null>(null)
  issueName = $state('')
  issuing = $state(false)
  issueError = $state<string | null>(null)
  actionError = $state<string | null>(null)
  readonly overlapByKey = new SvelteMap<string, number>()

  readonly #machineUserId: () => string
  readonly #canManage: () => boolean

  constructor(machineUserId: () => string, canManage: () => boolean) {
    this.#machineUserId = machineUserId
    this.#canManage = canManage
  }

  overlapFor(keyId: string): number {
    return this.overlapByKey.get(keyId) ?? DEFAULT_OVERLAP_MINUTES
  }

  setOverlap(keyId: string, raw: string): void {
    this.overlapByKey.set(keyId, Number(raw) || DEFAULT_OVERLAP_MINUTES)
  }

  hide(): void {
    this.revealedKey = null
  }

  async copy(): Promise<void> {
    const shown = this.revealedKey
    if (!shown) return
    try {
      await navigator.clipboard.writeText(shown.value)
    } catch {
      // Clipboard may be unavailable in some contexts.
    }
  }

  async issue(): Promise<void> {
    if (this.issuing || !this.#canManage()) return
    if (!this.issueName.trim()) {
      this.issueError = 'Name is required.'
      return
    }
    this.issuing = true
    this.issueError = null
    try {
      const created = await issueApiKey(fetch, this.#machineUserId(), {
        name: this.issueName.trim(),
      })
      this.revealedKey = { label: created.name, value: created.key }
      this.issueName = ''
      await invalidateAll()
    } catch (error) {
      this.issueError = apiErrorMessage(error, 'Failed to issue API key.')
    } finally {
      this.issuing = false
    }
  }

  async revoke(keyId: string): Promise<void> {
    this.actionError = null
    try {
      await revokeApiKey(fetch, this.#machineUserId(), keyId)
      await invalidateAll()
    } catch (error) {
      this.actionError = apiErrorMessage(error, 'Failed to revoke key.')
    }
  }

  async rotate(keyId: string, keyName: string): Promise<void> {
    this.actionError = null
    try {
      const result = await rotateApiKey(fetch, this.#machineUserId(), keyId, this.overlapFor(keyId))
      this.revealedKey = { label: `${keyName} (rotated)`, value: result.key }
      await invalidateAll()
    } catch (error) {
      this.actionError = apiErrorMessage(error, 'Failed to rotate key.')
    }
  }

  async emergencyRevoke(keyId: string, keyName: string): Promise<void> {
    this.actionError = null
    try {
      const result = await emergencyRevokeApiKey(fetch, this.#machineUserId(), keyId)
      this.revealedKey = {
        label: `${keyName} (emergency-revoked, new key)`,
        value: result.newKey,
      }
      await invalidateAll()
    } catch (error) {
      this.actionError = apiErrorMessage(error, 'Failed to emergency-revoke key.')
    }
  }
}
