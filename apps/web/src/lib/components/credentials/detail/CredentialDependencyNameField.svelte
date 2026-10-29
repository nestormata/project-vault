<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 69-14: the "System name" field group of the add-dependency form (a helper of the add
  // region, no region of its own). The typed value and its validation error are the controller's.
  let { controller }: { controller: CredentialDependenciesController } = $props()
</script>

<div class="space-y-1">
  <label class="block text-sm font-medium text-slate-800" for="dependency-system-name">
    System name
  </label>
  <input
    id="dependency-system-name"
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2"
    type="text"
    required
    bind:value={controller.depSystemName}
    aria-describedby={`dependency-system-name-help${controller.depNameError ? ' dependency-system-name-error' : ''}`}
    aria-invalid={controller.depNameError ? 'true' : undefined}
  />
  <FormHelpText id="dependency-system-name-help" kind="text" />
  {#if controller.depNameError}
    <p id="dependency-system-name-error" class="text-sm text-red-700" role="alert">
      {controller.depNameError}
    </p>
  {/if}
</div>
