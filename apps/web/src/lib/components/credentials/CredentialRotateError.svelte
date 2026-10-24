<script lang="ts">
  import { resolve } from '$app/paths'
  import type { RotateFormController } from './rotate-form.svelte.js'

  // Story 69.14: the start-rotation error banner (a conflict links to the active rotation).
  let {
    form,
    projectId,
    credentialId,
  }: { form: RotateFormController; projectId: string; credentialId: string } = $props()
</script>

<p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
  {#if form.conflictRotationId}
    <a
      class="font-medium underline"
      href={resolve(
        `/projects/${projectId}/credentials/${credentialId}/rotations/${form.conflictRotationId}`
      )}
    >
      {form.errorMessage}
    </a>
  {:else}
    {form.errorMessage}
    {#if form.errorMessage?.includes('MFA')}
      <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
    {/if}
  {/if}
</p>
