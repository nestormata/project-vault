<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialDependenciesRegionProps } from './credential-dependencies-controller.svelte.js'
  import CredentialDependencyLinkField from './CredentialDependencyLinkField.svelte'
  import CredentialDependencyNameField from './CredentialDependencyNameField.svelte'
  import CredentialDependencyNotesField from './CredentialDependencyNotesField.svelte'
  import CredentialDependencyScopeField from './CredentialDependencyScopeField.svelte'
  import CredentialDependencyTypeField from './CredentialDependencyTypeField.svelte'

  // Story 18.7 AC-5/6: collapsed by default behind a native <details>/<summary> disclosure — built-in
  // keyboard operability (Enter/Space on the summary) and expanded state exposed to assistive tech
  // for free, no bespoke bind:+ARIA needed. Open/closed state is plain client-side UI state
  // (`dependencyFormOpen`, bound via `bind:open`) and intentionally does not persist across reloads
  // (AC-6). Story 69-14: the form as one replaceable region; each field group is a helper component
  // bound to the controller's form state.
  let { controller, pointProps, data }: CredentialDependenciesRegionProps = $props()
</script>

<!-- @region credential.detail.dependencies-add -->
<details class="mt-6 border-t border-slate-200 pt-6" bind:open={controller.dependencyFormOpen}>
  <summary class="cursor-pointer font-semibold text-slate-950"> Add dependent system </summary>
  <form
    class="mt-3 space-y-3"
    onsubmit={(event) => {
      event.preventDefault()
      void controller.addDependency()
    }}
  >
    <CredentialDependencyNameField {controller} />
    <CredentialDependencyTypeField {controller} />
    <CredentialDependencyNotesField {controller} />
    {#if controller.fieldMeta.length > 1}
      <CredentialDependencyScopeField {controller} />
    {/if}
    <CredentialDependencyLinkField {controller} />
    {#if controller.depError}
      <p class="text-sm text-red-700" role="alert">{controller.depError}</p>
    {/if}
    {#if controller.depBanner}
      <p class="text-sm text-red-700" role="alert">{controller.depBanner}</p>
    {/if}
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
      type="submit"
      disabled={controller.depSubmitting || controller.isArchived}
    >
      {controller.depSubmitting ? 'Adding…' : 'Add dependent system'}
    </button><InjectionPoint name="credential.detail.dependencies-add" props={pointProps} {data} />
  </form>
</details>
