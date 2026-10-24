<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import { decrementUnread } from '$lib/state/notifications.svelte.js'
  import { enhance } from '$app/forms'

  // Story 69.11: the mark-as-read and dismiss forms of one notification. A successful action updates
  // the row locally (the route's callbacks) and the unread badge, then re-runs the page load.
  let {
    notification,
    markReadLocally,
    dismissLocally,
  }: {
    notification: InboxEntry
    markReadLocally: (id: string) => void
    dismissLocally: (id: string) => void
  } = $props()
</script>

{#if !notification.readAt}
  <form
    method="POST"
    action="?/markRead"
    use:enhance={() =>
      async ({ result, update }) => {
        if (result.type === 'success') {
          markReadLocally(notification.id)
          decrementUnread(1)
        }
        void update()
      }}
  >
    <input type="hidden" name="id" value={notification.id} />
    <button type="submit" class="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
      Mark as read
    </button>
  </form>
{/if}
<form
  method="POST"
  action="?/dismiss"
  use:enhance={() =>
    async ({ result, update }) => {
      if (result.type === 'success') {
        if (!notification.readAt) decrementUnread(1)
        dismissLocally(notification.id)
      }
      void update()
    }}
>
  <input type="hidden" name="id" value={notification.id} />
  <button type="submit" class="cursor-pointer text-xs text-red-500 hover:text-red-700">
    Dismiss
  </button>
</form>
