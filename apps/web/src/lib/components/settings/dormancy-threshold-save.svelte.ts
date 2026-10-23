import { ApiClientError } from '$lib/api/client.js'
import type { DormancyThresholdDays } from '$lib/api/organization-settings.js'

/**
 * The "set a new value, no readback" save shared by the two dormancy threshold cards of the users
 * page (machine key and user): the API only ships a PATCH, so the current value cannot be shown and
 * the select starts unselected. One instance per card; `save` returns the value the server stored.
 */
export class DormancyThresholdSave {
  choice = $state<DormancyThresholdDays | ''>('')
  saving = $state(false)
  savedTo = $state<number | null>(null)
  error = $state<string | null>(null)
  private readonly save: (days: DormancyThresholdDays) => Promise<number>

  constructor(save: (days: DormancyThresholdDays) => Promise<number>) {
    this.save = save
  }

  async submit(): Promise<void> {
    if (this.saving || this.choice === '') return
    this.saving = true
    this.error = null
    this.savedTo = null
    try {
      this.savedTo = await this.save(this.choice)
    } catch (error) {
      this.error =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update dormancy threshold.')
          : 'Failed to update dormancy threshold.'
    } finally {
      this.saving = false
    }
  }
}
