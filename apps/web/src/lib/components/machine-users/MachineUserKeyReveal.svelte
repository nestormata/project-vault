<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type { PointData } from './machine-user-detail.js'
  import type { MachineUserKeys } from './machine-user-keys.svelte.js'

  // Story 69.14: the one-time display of a new API key as one replaceable region. The key lives in
  // the keys controller owned by the detail content, so issue, rotate and emergency revoke all
  // reveal through it.
  let { keys, data }: { keys: MachineUserKeys; data?: PointData } = $props()
</script>

<!-- @region project.machine-users-detail.key-reveal -->
<RegionFragment>
  {#if keys.revealedKey}
    <section class="rounded-2xl border border-amber-300 bg-amber-50 p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">
        New API key — {keys.revealedKey.label}
      </h2>
      <p class="mt-1 text-sm font-semibold text-red-700">
        This value will never be shown again. Copy it now.
      </p>
      <pre
        class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{keys
          .revealedKey.value}</pre>
      <div class="mt-3 flex gap-3">
        <button
          class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
          type="button"
          onclick={() => void keys.copy()}
        >
          Copy
        </button>
        <button
          class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
          type="button"
          onclick={() => keys.hide()}
        >
          Hide
        </button><InjectionPoint name="project.machine-users-detail.key-reveal" {data} />
      </div>
    </section>
  {/if}
</RegionFragment>
