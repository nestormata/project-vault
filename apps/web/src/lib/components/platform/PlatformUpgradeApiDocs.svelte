<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the "API Documentation" card of the platform upgrade page. A contribution at
  // `platform.upgrade.api-docs` renders inside the card, after the link or the "not enabled" note.
  let {
    apiDocsEnabled,
    data,
  }: {
    apiDocsEnabled: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.upgrade.api-docs -->
<RegionFragment>
  <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
    <h2 class="text-base font-semibold text-gray-900">API Documentation</h2>
    <div class="mt-3 text-sm text-gray-700">
      {#if apiDocsEnabled}
        <a
          href={resolve('/api/v1/docs')}
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-indigo-600 underline"
        >
          Open API Documentation (Swagger UI) →
        </a>
      {:else}
        <p class="text-gray-500">
          API documentation browsing is not enabled on this instance. Set
          <code class="font-mono text-xs">ENABLE_API_DOCS=true</code> to enable it.
        </p>
      {/if}<InjectionPoint name="platform.upgrade.api-docs" {data} />
    </div>
  </section>
</RegionFragment>
