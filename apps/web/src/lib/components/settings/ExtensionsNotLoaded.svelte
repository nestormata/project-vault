<script lang="ts">
  import type { ExtensionsHealthStatus } from '../../../routes/(app)/settings/extensions/+page.server.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the extension status when no manifest is loaded (a failed load, or none configured).
  let {
    healthStatus,
    data,
  }: {
    healthStatus: ExtensionsHealthStatus | null
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.extensions.not-loaded -->
<RegionFragment>
  {#if healthStatus === 'load_failed'}
    <!-- AC-4: honest, visually/textually distinct from AC-3's not-configured state. Never
         surfaces the raw failure reason — points at server logs / the audit log instead.
         No link to /settings/audit: that page gates on org role 'owner', a stricter role than
         this page's 'admin' gate (AC-5) — every viewer who can reach this branch is 'admin', so
         a link here would always point at a permission wall. Text reference only. -->
    <div class="mt-8 rounded-2xl border border-red-200 bg-red-50 p-6">
      <p class="text-red-800">
        The configured extension failed to load. Core vault functionality is unaffected. Check the
        server's structured logs and this org's audit log for details.
      </p>
      <p class="mt-3 text-xs text-red-700">
        No capability gate configured — all capabilities are available.
      </p>
      <!-- Story 23.8 AC-26 -->
      <p class="mt-1 text-xs text-red-700">
        Audit event source: not declared — extension domain events are not being written to the
        audit log.
      </p>
    </div>
  {:else}
    <!-- AC-3: the expected, common, non-error default for most self-hosted installs. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">No extension configured for this vault.</p>
      <p class="mt-3 text-xs text-slate-500">
        No capability gate configured — all capabilities are available.
      </p>
      <!-- Story 23.8 AC-26 -->
      <p class="mt-1 text-xs text-slate-500">
        Audit event source: not declared — extension domain events are not being written to the
        audit log.
      </p>
    </div>
  {/if}<InjectionPoint name="settings.extensions.not-loaded" {data} />
</RegionFragment>
