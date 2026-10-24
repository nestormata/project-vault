<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'

  // Story 69.10: the banners that report a settings save (success, error, MFA required) as one
  // replaceable region. The settings form owns the save outcome.
  let {
    saveSuccess,
    saveError,
    saveMfaError,
    data,
  }: {
    saveSuccess: boolean
    saveError: string | null
    saveMfaError: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.save-status -->
<RegionFragment>
  {#if saveSuccess}
    <p
      class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
      role="status"
    >
      Settings saved successfully.
    </p>
  {/if}
  {#if saveError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {saveError}
    </p>
  {/if}
  {#if saveMfaError}
    <MfaAwareErrorAlert
      message={saveMfaError}
      class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    />
  {/if}<InjectionPoint name="platform.settings.save-status" {data} />
</RegionFragment>
