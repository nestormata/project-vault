<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: why the last import attempt failed.
  let {
    errorMessage,
    data,
  }: {
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.import.error -->
<RegionFragment>
  {#if errorMessage}
    <p class="text-sm text-red-700">{errorMessage}</p>
  {/if}<InjectionPoint name="project.import.error" {data} />
</RegionFragment>
