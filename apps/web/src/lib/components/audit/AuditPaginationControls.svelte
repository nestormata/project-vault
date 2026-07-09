<script lang="ts">
  interface Props {
    page: number
    total: number
    hasNext: boolean
    pageHref: (p: number) => string
  }
  let { page, total, hasNext, pageHref }: Props = $props()
</script>

<div class="mt-3 flex flex-wrap items-center justify-between gap-2">
  <p class="text-sm text-slate-500">{total} total — page {page}</p>
  <div class="flex gap-2">
    {#if page > 1}
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a href={pageHref(page - 1)} class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
        Previous
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
    {#if hasNext}
      <!-- eslint-disable svelte/no-navigation-without-resolve -->
      <a href={pageHref(page + 1)} class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50">
        Next
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  </div>
</div>
