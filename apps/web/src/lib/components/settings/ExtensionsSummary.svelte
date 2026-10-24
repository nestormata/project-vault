<script lang="ts">
  import type { ExtensionStatus } from '$lib/api/extensions.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the identity of the loaded extension (name, API version, package version).
  let {
    manifest,
    data,
  }: {
    manifest: ExtensionStatus
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.extensions.summary -->
<RegionFragment>
  <p class="text-sm font-medium text-emerald-700">Loaded</p>
  <p class="mt-2 text-lg font-semibold text-slate-900">{manifest.name}</p>
  <!-- Story 25.9 AC4: "Version" was ambiguous — it rendered `manifest.apiVersion` (the
       extension-API *contract* version) under a label an operator could easily mistake for
       the module pack's own release. Relabeled "API version", with a separately-labeled
       "Package version" line below for the pack's own release (new in this story). -->
  <p class="mt-1 text-sm text-slate-600">API version {manifest.apiVersion}</p>
  {#if manifest.packageVersion}
    <p class="mt-1 text-sm text-slate-600">Package version {manifest.packageVersion}</p>
  {:else}
    <p class="mt-1 text-sm text-slate-600">Package version unknown</p>
  {/if}<InjectionPoint name="settings.extensions.summary" {data} />
</RegionFragment>
