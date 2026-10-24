<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the empty state of the inbox. The wording depends on the active status tab.
  let {
    status,
    data,
  }: {
    status: 'all' | 'unread' | 'read'
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region notifications.home.empty -->
<RegionFragment>
  <div class="py-16 text-center">
    <svg
      class="mx-auto mb-4 h-12 w-12 text-gray-300"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.5"
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
      />
    </svg>
    <p class="text-lg text-gray-500">No notifications</p>
    {#if status === 'unread'}
      <p class="mt-1 text-sm text-gray-400">You're all caught up!</p>
    {:else}
      <p class="mt-1 text-sm text-gray-400">Notifications will appear here when alerts fire.</p>
    {/if}<InjectionPoint name="notifications.home.empty" {data} />
  </div>
</RegionFragment>
