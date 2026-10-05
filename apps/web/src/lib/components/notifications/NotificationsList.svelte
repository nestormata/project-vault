<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import type { Snippet } from 'svelte'
  import { decrementUnread } from '$lib/state/notifications.svelte.js'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'

  let {
    notifications,
    status,
    page,
    hasNext,
    markReadLocally,
    dismissLocally,
    children,
  }: {
    notifications: InboxEntry[]
    status: 'all' | 'unread' | 'read'
    page: number
    hasNext: boolean
    markReadLocally: (id: string) => void
    dismissLocally: (id: string) => void
    children?: Snippet
  } = $props()

  const ALERT_TYPE_LABELS: Record<string, string> = {
    'security.failed_auth_threshold': 'Failed Login Threshold',
    'credential.expiry': 'Secret Expiry',
    'service.down': 'Service Down',
    'rotation.stale': 'Stale Rotation',
    'backup.failure': 'Backup Failure',
    'machine_key.expiry': 'Machine Key Expiry',
    'security.anomalous_access': 'Anomalous Access',
  }
  const SEVERITY_DOT: Record<string, string> = {
    info: 'bg-blue-400',
    warning: 'bg-yellow-400',
    critical: 'bg-red-500',
  }
  const SEVERITY_COLORS: Record<string, string> = {
    info: 'bg-blue-50 border-blue-200',
    warning: 'bg-yellow-50 border-yellow-200',
    critical: 'bg-red-50 border-red-200',
  }
</script>

{@render children?.()}
{#if notifications.length === 0}
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
    <p class="mt-1 text-sm text-gray-400">
      {status === 'unread'
        ? "You're all caught up!"
        : 'Notifications will appear here when alerts fire.'}
    </p>
  </div>
{:else}
  <div class="space-y-3">
    {#each notifications as notification (notification.id)}
      <div
        class="rounded-lg border p-4 {SEVERITY_COLORS[notification.severity] ??
          'border-gray-200 bg-gray-50'} {!notification.readAt ? 'shadow-sm' : 'opacity-75'}"
      >
        <div class="flex items-start gap-3">
          <div
            class="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full {SEVERITY_DOT[notification.severity] ??
              'bg-gray-400'}"
          ></div>

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <div>
                <span class="text-xs font-medium uppercase tracking-wide text-gray-500">
                  {ALERT_TYPE_LABELS[notification.alertType] ?? notification.alertType}
                </span>
                <h3 class="mt-0.5 text-sm font-semibold text-gray-900">{notification.title}</h3>
              </div>
              <div class="flex flex-shrink-0 items-center gap-2">
                <time class="text-xs text-gray-400" datetime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleDateString()}
                </time>
                {#if !notification.readAt}
                  <span class="h-2 w-2 rounded-full bg-indigo-500" title="Unread"></span>
                {/if}
              </div>
            </div>

            <p class="mt-1 line-clamp-3 text-sm text-gray-600">{notification.body}</p>

            <div class="mt-3 flex items-center gap-4">
              {#if notification.projectId}
                <a
                  href={resolve(`/projects/${notification.projectId}`)}
                  class="text-xs text-indigo-600 hover:underline"
                >
                  View project →
                </a>
              {/if}
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
                  <button
                    type="submit"
                    class="cursor-pointer text-xs text-gray-500 hover:text-gray-700"
                  >
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
                <button
                  type="submit"
                  class="cursor-pointer text-xs text-red-500 hover:text-red-700"
                >
                  Dismiss
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    {/each}
  </div>

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
    {/if}
  </div>
{/if}
