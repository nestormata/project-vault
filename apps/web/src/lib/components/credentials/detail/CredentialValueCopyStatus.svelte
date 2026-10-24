<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { CredentialValueRegionProps } from './credential-value-controller.svelte.js'

  // Story 69-14: the announced copy confirmations (or failures) of the Secret value section as one
  // replaceable region. The list is the controller's, shared by the single and per-field copy buttons.
  let { controller, pointProps, data }: CredentialValueRegionProps = $props()
</script>

<!-- @region credential.detail.value-copy-status -->
<RegionFragment>
  {#each controller.copyStatuses as status (status.id)}
    <p
      class={`mt-3 text-sm ${status.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
      role="status"
      aria-live="polite"
    >
      {status.message}
    </p>
  {/each}<InjectionPoint name="credential.detail.value-copy-status" props={pointProps} {data} />
</RegionFragment>
