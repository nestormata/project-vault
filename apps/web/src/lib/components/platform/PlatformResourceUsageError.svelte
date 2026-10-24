<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'

  // Story 69.14: the usage load-failure banner as one replaceable region.
  let {
    errorMessage,
    data,
  }: {
    errorMessage: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings-resource-usage.error -->
<RegionFragment>
  <MfaAwareErrorAlert
    message={errorMessage}
    class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
  /><InjectionPoint name="platform.settings-resource-usage.error" {data} />
</RegionFragment>
