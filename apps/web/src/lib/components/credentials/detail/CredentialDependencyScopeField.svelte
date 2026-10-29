<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 13.5 AC-6: only rendered for multi-field credentials — hidden entirely for
  // single-field/legacy credentials (matches the rotation field-selector's own field_meta.length > 1
  // gating convention, Story 13.4). Story 69-14: the "Scope to field" group of the add-dependency form
  // (a helper of the add region, no region of its own).
  let { controller }: { controller: CredentialDependenciesController } = $props()
</script>

<div class="space-y-1">
  <label class="block text-sm font-medium text-slate-800" for="dependency-field-key">
    Scope to field
  </label>
  <select
    id="dependency-field-key"
    class="w-full max-w-xs rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2"
    aria-describedby="dependency-field-key-help"
    bind:value={controller.depFieldKey}
  >
    <option value="">Whole secret</option>
    {#each controller.fieldMeta as field (field.key)}
      <option value={field.key}>{field.key}</option>
    {/each}
  </select>
  <FormHelpText id="dependency-field-key-help" text={m.form_help_dependency_scope()} />
</div>
