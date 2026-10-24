<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 69-14: the "System type" field group of the add-dependency form (a helper of the add
  // region, no region of its own).
  let { controller }: { controller: CredentialDependenciesController } = $props()
</script>

<div class="space-y-1">
  <label class="block text-sm font-medium text-slate-800" for="dependency-system-type">
    System type
  </label>
  <select
    id="dependency-system-type"
    class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
    aria-describedby="dependency-system-type-help"
    bind:value={controller.depSystemType}
  >
    <option value="service">Service</option>
    <option value="ci_pipeline">CI pipeline</option>
    <option value="database">Database</option>
    <option value="third_party">Third party</option>
    <option value="other">Other</option>
  </select>
  <FormHelpText id="dependency-system-type-help" text={m.form_help_dependency_system_type()} />
</div>
