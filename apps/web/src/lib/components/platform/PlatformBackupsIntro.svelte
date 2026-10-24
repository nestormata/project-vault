<script lang="ts">
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { BackupsController } from './backups-controller.svelte.js'

  // Story 69.14: the backups page's heading and the trigger-backup control as one replaceable region.
  let {
    controller,
    data,
  }: {
    controller: BackupsController
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.backups.intro -->
<div class="flex items-center justify-between">
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Backups</h1>
    <p class="mt-1 text-gray-500">Trigger, validate, and restore encrypted backups.</p>
  </div>
  <ConfirmDeleteButton
    label="Trigger backup now"
    confirmLabel="Confirm trigger?"
    pendingLabel="Triggering…"
    onConfirm={() => controller.trigger()}
  /><InjectionPoint name="platform.backups.intro" {data} />
</div>
