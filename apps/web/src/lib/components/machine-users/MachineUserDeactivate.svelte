<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { deactivateMachineUser } from '$lib/api/machine-users.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import { apiErrorMessage, type PointData } from './machine-user-detail.js'

  // Story 69.14: the deactivate control of the machine user card as one replaceable region. It owns
  // its own pending and error state, which nothing else reads.
  let { machineUserId, show, data }: { machineUserId: string; show: boolean; data?: PointData } =
    $props()

  let deactivateError = $state<string | null>(null)
  let deactivating = $state(false)
  async function onDeactivate() {
    if (deactivating) return
    deactivating = true
    deactivateError = null
    try {
      await deactivateMachineUser(fetch, machineUserId)
      await invalidateAll()
    } catch (error) {
      deactivateError = apiErrorMessage(error, 'Failed to deactivate machine user.')
    } finally {
      deactivating = false
    }
  }
</script>

<!-- @region project.machine-users-detail.deactivate -->
<RegionFragment>
  {#if show}
    <div class="mt-5">
      {#if deactivateError}
        <p class="mb-2 text-sm text-red-700" role="alert">{deactivateError}</p>
      {/if}
      <ConfirmDeleteButton
        label="Deactivate"
        confirmLabel="Confirm deactivate?"
        pendingLabel="Deactivating…"
        onConfirm={onDeactivate}
      /><InjectionPoint name="project.machine-users-detail.deactivate" {data} />
    </div>
  {/if}
</RegionFragment>
