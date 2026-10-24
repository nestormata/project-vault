<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  // Story 69.11: the previous/next links under a non-empty inbox page, as one replaceable region.
  let {
    status,
    page,
    hasNext,
    data,
  }: {
    status: 'all' | 'unread' | 'read'
    page: number
    hasNext: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region notifications.home.pagination -->
<div class="mt-8 flex justify-center gap-2">
  {#if page > 1}
    <a
      href="{resolve('/notifications')}?page={page - 1}&status={status}"
      class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
    >
      Previous
    </a>
  {/if}
  {#if hasNext}
    <a
      href="{resolve('/notifications')}?page={page + 1}&status={status}"
      class="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
    >
      Next
    </a>
  {/if}<InjectionPoint name="notifications.home.pagination" {data} />
</div>
