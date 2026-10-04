<script lang="ts">
  import type {
    HealthHistoryEntry,
    HealthHistoryFailureReason,
  } from '$lib/api/service-endpoints.js'

  // Story 69.3: the list of recent health checks of an endpoint, moved verbatim out of the detail
  // page so the history region wraps a component. Reverse-chronological, as the page loads it.
  let { items }: { items: HealthHistoryEntry[] } = $props()

  // ADR-6.2-12: real diagnostic information, not collapsed into one generic "failed" label.
  function failureReasonLabel(reason: HealthHistoryFailureReason | null): string {
    if (!reason) return '—'
    switch (reason) {
      case 'ssrf_blocked':
        return 'Blocked (unsafe address)'
      case 'timeout':
        return 'Timed out'
      case 'http_error':
        return 'HTTP error'
      case 'network_error':
        return 'Network error'
    }
  }

  function formatDateTime(value: string): string {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
</script>

<ul class="mt-4 space-y-2">
  {#each items as entry (entry.checkedAt + String(entry.statusCode))}
    <li
      class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
    >
      <span>{formatDateTime(entry.checkedAt)}</span>
      <span>{entry.isHealthy ? 'Healthy' : 'Unhealthy'}</span>
      <span>{entry.statusCode ?? '—'}</span>
      <span>{entry.latencyMs} ms</span>
      <span>{failureReasonLabel(entry.failureReason)}</span>
    </li>
  {/each}
</ul>
