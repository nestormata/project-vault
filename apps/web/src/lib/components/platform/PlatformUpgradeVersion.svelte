<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the "Current Version" card of the platform upgrade page. A contribution at
  // `platform.upgrade.version` renders inside the card, after the version text.
  let {
    version,
    versionSource,
    data,
  }: {
    version: string | null
    versionSource: string | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.upgrade.version -->
<RegionFragment>
  <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
    <h2 class="text-base font-semibold text-gray-900">Current Version</h2>
    {#if version}
      <p class="mt-2 text-sm text-gray-700">Running version <strong>{version}</strong>.</p>
      {#if versionSource === 'release'}
        <p class="mt-1 text-sm text-gray-500">This is a release build.</p>
      {:else if versionSource === 'development'}
        <p class="mt-1 text-sm text-gray-500">
          This is a development build — not a production release.
        </p>
      {:else}
        <p class="mt-1 text-sm text-gray-500">Build type unknown.</p>
      {/if}
    {:else}
      <p class="mt-2 text-sm text-gray-500">Version information unavailable.</p>
    {/if}<InjectionPoint name="platform.upgrade.version" {data} />
  </section>
</RegionFragment>
