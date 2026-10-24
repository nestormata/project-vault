<script lang="ts">
  import { resolve } from '$app/paths'
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

  const pageQuery = (target: number): string =>
    `?${asOf ? `asOf=${encodeURIComponent(asOf)}&` : ''}page=${target}`
</script>

<!-- @region settings.audit-access-report.pagination -->
<RegionFragment>
  <div class="mt-4 flex justify-center gap-2">
    {#if (page ?? 1) > 1}
      <a
        href="{resolve('/settings/audit/access-report')}{pageQuery((page ?? 1) - 1)}"
        class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Previous
      </a>
    {/if}
    {#if hasNext}
      <a
        href="{resolve('/settings/audit/access-report')}{pageQuery((page ?? 1) + 1)}"
        class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Next
      </a>
    {/if}<InjectionPoint name="settings.audit-access-report.pagination" {data} />
  </div>
</RegionFragment>
