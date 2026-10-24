<script lang="ts">
  import type { InboxEntry } from '$lib/api/inbox.js'
  import { resolve } from '$app/paths'
  import NotificationCardActions from './NotificationCardActions.svelte'

  // Story 69.11: one notification of the inbox (severity dot, label, title, date, body, actions).
  let {
    notification,
    markReadLocally,
    dismissLocally,
  }: {
    notification: InboxEntry
    markReadLocally: (id: string) => void
    dismissLocally: (id: string) => void
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
        <NotificationCardActions {notification} {markReadLocally} {dismissLocally} />
      </div>
    </div>
  </div>
</div>
