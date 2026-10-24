<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the previous/next links under the access report table. They carry the `asOf` date
  // forward so a later page keeps the same report.
  let {
    asOf,
    page,
    hasNext,
    data,
  }: {
    asOf: string | undefined
    page: number | undefined
    hasNext: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit-access-report.pagination -->
<RegionFragment>
  <div class="mt-4 flex justify-center gap-2">
    {#if (page ?? 1) > 1}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- dynamic query string, not a literal resolve() can type-check (`-next-line` doesn't reach `href` on a multi-line tag) -->
      <a
        href="?{asOf ? `asOf=${asOf}&` : ''}page={(page ?? 1) - 1}"
        class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Previous
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
    {#if hasNext}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- dynamic query string, not a literal resolve() can type-check (`-next-line` doesn't reach `href` on a multi-line tag) -->
      <a
        href="?{asOf ? `asOf=${asOf}&` : ''}page={(page ?? 1) + 1}"
        class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Next
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}<InjectionPoint name="settings.audit-access-report.pagination" {data} />
  </div>
</RegionFragment>
