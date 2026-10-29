<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialValueRegionProps } from './credential-value-controller.svelte.js'

  // Adding a new version to a legacy/single-field secret. Story 69-14: as one replaceable region. The
  // typed value is the controller's local state and never reaches the point's props or `data`.
  let { controller, pointProps, data }: CredentialValueRegionProps = $props()
</script>

<!-- @region credential.detail.value-add-version -->
<RegionFragment>
  <h3 class="font-semibold text-slate-950">Add new version</h3>
  <form
    class="mt-3 space-y-3"
    onsubmit={(event) => {
      event.preventDefault()
      void controller.addVersion()
    }}
  >
    <div class="space-y-1">
      <label class="block text-sm font-medium text-slate-800" for="new-version-value">
        New value
      </label>
      <textarea
        id="new-version-value"
        class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2 font-mono text-sm"
        bind:value={controller.newVersionValue}
        aria-describedby="new-version-value-help"></textarea>
      <FormHelpText id="new-version-value-help" kind="secret" />
    </div>
    {#if controller.addVersionError}
      <p class="text-sm text-red-700" role="alert">{controller.addVersionError}</p>
    {/if}
    {#if controller.addVersionBanner}
      <p class="text-sm text-red-700" role="alert">{controller.addVersionBanner}</p>
    {/if}
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={controller.addingVersion || controller.isArchived}
    >
      {controller.addingVersion ? 'Adding…' : 'Add version'}
    </button><InjectionPoint name="credential.detail.value-add-version" props={pointProps} {data} />
  </form>
</RegionFragment>
