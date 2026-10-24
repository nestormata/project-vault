<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 69-14: the "Notes" field group of the add-dependency form (a helper of the add region, no
  // region of its own).
  let { controller }: { controller: CredentialDependenciesController } = $props()
</script>

<div class="space-y-1">
  <label class="block text-sm font-medium text-slate-800" for="dependency-notes"> Notes </label>
  <textarea
    id="dependency-notes"
    class="w-full rounded-xl border border-slate-300 px-3 py-2"
    bind:value={controller.depNotes}
    aria-describedby="dependency-notes-help"></textarea>
  <FormHelpText id="dependency-notes-help" kind="text" />
</div>
