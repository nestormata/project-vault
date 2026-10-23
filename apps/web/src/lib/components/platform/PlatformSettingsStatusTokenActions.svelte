<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.10: the generate / rotate, revoke and test buttons of the status token as one
  // replaceable region. The card owns the busy flags and the handlers.
  let {
    configured,
    busy,
    testBusy,
    onGenerateOrRotate,
    onRevoke,
    onTest,
    data,
  }: {
    configured: boolean
    busy: boolean
    testBusy: boolean
    onGenerateOrRotate: () => Promise<void>
    onRevoke: () => Promise<void>
    onTest: () => Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.status-token-actions -->
<RegionFragment>
  <div class="mt-4 flex flex-wrap gap-2" aria-describedby="status-token-help">
    <button
      type="button"
      disabled={busy}
      class="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
      onclick={onGenerateOrRotate}
    >
      {configured ? m.status_token_rotate_button() : m.status_token_generate_button()}
    </button>
    {#if configured}
      <button
        type="button"
        disabled={busy}
        class="rounded-lg border border-red-300 px-4 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
        onclick={onRevoke}
      >
        {m.status_token_revoke_button()}
      </button>
    {/if}
    <button
      type="button"
      disabled={testBusy}
      class="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
      onclick={onTest}
    >
      {testBusy ? m.status_token_test_button_busy() : m.status_token_test_button()}
    </button><InjectionPoint name="platform.settings.status-token-actions" {data} />
  </div>
</RegionFragment>
