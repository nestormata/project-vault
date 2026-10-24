<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { PlatformOrgCreate } from './platform-org-create.svelte.js'

  // Story 69.11: the create-organization form (name and first owner email).
  let {
    create,
    data,
  }: {
    create: PlatformOrgCreate
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-orgs.create-form -->
<form class="mt-4 flex flex-col gap-4" onsubmit={(e) => void create.submit(e)}>
  <label class="flex flex-col text-sm text-gray-700">
    Organization name
    <input
      type="text"
      required
      bind:value={create.newOrgName}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      placeholder="Acme Corp"
      aria-describedby="platform-org-name-help"
    />
    <FormHelpText id="platform-org-name-help" kind="text" />
    {#if create.createNameError}
      <span class="mt-1 text-xs text-red-600">{create.createNameError}</span>
    {/if}
  </label>
  <label class="flex flex-col text-sm text-gray-700">
    Owner email
    <input
      type="email"
      required
      bind:value={create.newOrgOwnerEmail}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      placeholder="Email of the first admin"
      aria-describedby="platform-org-owner-help"
    />
    <FormHelpText id="platform-org-owner-help" kind="text" />
  </label>
  <div>
    <button
      type="submit"
      disabled={create.creating}
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
    >
      {create.creating ? 'Creating…' : 'Create organization'}
    </button><InjectionPoint name="platform.settings-orgs.create-form" {data} />
  </div>
</form>
