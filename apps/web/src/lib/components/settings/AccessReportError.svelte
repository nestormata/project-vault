<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: why the access report could not be generated.
  let {
    errorMessage,
    data,
  }: {
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-access-report.error -->
<RegionFragment>
  {#if errorMessage}
    <p
      class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
      role="alert"
    >
      {errorMessage}
    </p>
  {/if}<InjectionPoint name="settings.audit-access-report.error" {data} />
</RegionFragment>
