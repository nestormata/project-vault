<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import NotificationCard from './NotificationCard.svelte'

  // Story 69.11: the notification cards of a non-empty inbox page as one replaceable region.
  let {
    notifications,
    markReadLocally,
    dismissLocally,
    data,
  }: {
    notifications: InboxEntry[]
    markReadLocally: (id: string) => void
    dismissLocally: (id: string) => void
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region notifications.home.items -->
<div class="space-y-3">
  {#each notifications as notification (notification.id)}
    <NotificationCard {notification} {markReadLocally} {dismissLocally} />
  {/each}<InjectionPoint name="notifications.home.items" {data} />
</div>
