<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the submit failure banner of the new secret form.
  let {
    errorMessage,
    data,
  }: {
    errorMessage: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.credentials-new.error -->
<RegionFragment>
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}<InjectionPoint name="project.credentials-new.error" {data} />
</RegionFragment>
