<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'

  // Story 69-14: the "Link (optional)" field group of the add-dependency form (a helper of the add
  // region, no region of its own).
  let { controller }: { controller: CredentialDependenciesController } = $props()
</script>

<div class="space-y-1">
  <label class="block text-sm font-medium text-slate-800" for="dependency-link-url">
    Link (optional)
  </label>
  <input
    id="dependency-link-url"
    class="w-full rounded-xl border border-slate-300 px-3 py-2"
    type="url"
    placeholder="https://…"
    aria-describedby="dependency-link-url-help dependency-link-url-security-note"
    bind:value={controller.depLinkUrl}
  />
  <FormHelpText id="dependency-link-url-help" text={m.form_help_dependency_link()} />
  <p id="dependency-link-url-security-note" class="text-xs text-slate-500">
    This link is visible to everyone with view access to this secret and is stored in plaintext
    audit logs.
  </p>
</div>
