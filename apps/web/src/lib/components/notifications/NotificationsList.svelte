<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import type { Snippet } from 'svelte'
  import NotificationsEmpty from './NotificationsEmpty.svelte'
  import NotificationsItems from './NotificationsItems.svelte'
  import NotificationsPagination from './NotificationsPagination.svelte'

  // Story 69.11: the inbox is the empty state, or the notification cards followed by the pagination
  // links, each its own sub-region. The route owns the entries and the local mark-read/dismiss
  // updates; `data` is its `__inject` map.
  let {
    notifications,
    status,
    page,
    hasNext,
    markReadLocally,
    dismissLocally,
    data,
    children,
  }: {
    notifications: InboxEntry[]
    status: 'all' | 'unread' | 'read'
    page: number
    hasNext: boolean
    markReadLocally: (id: string) => void
    dismissLocally: (id: string) => void
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if notifications.length === 0}
  <NotificationsEmpty {status} {data} />
{:else}
  <NotificationsItems {notifications} {markReadLocally} {dismissLocally} {data} />

  <NotificationsPagination {status} {page} {hasNext} {data} />
{/if}
