<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: why the last import step failed.
  let {
    errorMessage,
    data,
  }: {
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-import.error -->
<RegionFragment>
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}<InjectionPoint name="project.credentials-import.error" {data} />
</RegionFragment>
