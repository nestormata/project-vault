<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import type { Snippet } from 'svelte'
  import { markAllReadLocally } from '$lib/state/notifications.svelte.js'
  import { enhance } from '$app/forms'

  let {
    notifications,
    markAllReadLocallyInList,
    children,
  }: { notifications: InboxEntry[]; markAllReadLocallyInList: () => void; children?: Snippet } =
    $props()
</script>

<div class="mb-6 flex items-center justify-between">
  <h1 class="text-2xl font-bold text-gray-900">Notifications</h1>
  {#if notifications.some((n) => !n.readAt)}
    <form
      method="POST"
      action="?/markAllRead"
      use:enhance={() =>
        // Story 68.1 (C4): SvelteKit calls the value returned here as the post-response
        // callback. It used to be an `{ update }` object, which SvelteKit tried to call and
        // threw `callback is not a function`, so the list never updated until a reload.
        async ({ result, update }) => {
          // Only apply the optimistic mutation once the server actually confirms success —
          // otherwise a failed action (e.g. a downstream error) would leave the UI showing a
          // false success state with no way back short of a manual reload.
          if (result.type === 'success') {
            markAllReadLocallyInList()
            markAllReadLocally()
          }
          void update()
        }}
    >
      <button
        type="submit"
        class="cursor-pointer text-sm font-medium text-indigo-600 hover:text-indigo-800"
      >
        Mark all as read
      </button>
    </form>
  {/if}
</div>
{@render children?.()}
