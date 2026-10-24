<script lang="ts">
  import type { ExtensionStatus } from '$lib/api/extensions.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: when the extension was loaded and what its manifest declares (capability gate,
  // audit event source). Manifest-derived only: this page has no liveness data.
  let {
    manifest,
    data,
  }: {
    manifest: ExtensionStatus
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 23.8 AC-26: same honest-placeholder bar as AC-9 above — declaration-presence only, no
  // liveness/activity claim (this page cannot reach the operational /status endpoint).
  const declaresAuditEventSource = $derived(manifest.capabilities.includes('audit-event-source'))
  // Story 23.3 AC-9/AC-33: the page has NO liveness data — it can read exactly one thing, the
  // loaded manifest's declared `capabilities` array. Neither line below asserts that gating is
  // or is not actually in effect; whether a declared gate is registered is reported only on the
  // operational status endpoint (AC-26), which this page cannot reach.
  const declaresCapabilityGate = $derived(manifest.capabilities.includes('capability-gate'))
  function formatLoadedAt(iso: string): string {
    return new Date(iso).toLocaleString()
  }
</script>

<!-- @region settings.extensions.declarations -->
<RegionFragment>
  <p class="mt-4 text-xs text-slate-500">
    Loaded at {formatLoadedAt(manifest.loadedAt)}
  </p>

  <!-- Story 23.3 AC-9/AC-33: manifest-derived only — see the declaresCapabilityGate comment
       above for why the copy stops short of a liveness claim. -->
  <p class="mt-3 text-xs text-slate-500">
    {#if declaresCapabilityGate}
      This extension declares a capability gate. Whether it is actually registered is reported on
      the operational status endpoint.
    {:else}
      No capability gate configured — all capabilities are available.
    {/if}
  </p>

  <!-- Story 23.8 AC-26 -->
  {#if declaresAuditEventSource}
    <p class="mt-1 text-xs text-slate-500">Audit event source: declared</p>
  {:else}
    <p class="mt-1 text-xs text-slate-500">
      Audit event source: not declared — extension domain events are not being written to the audit
      log.
    </p>
  {/if}<InjectionPoint name="settings.extensions.declarations" {data} />
</RegionFragment>
