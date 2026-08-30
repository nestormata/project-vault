<script lang="ts">
  import {
    statusBadgeClass,
    statusBadgeLabel,
    formatCheckedAt,
    type ServiceHealthStatus,
  } from './service-status'

  let {
    name,
    status,
    lastCheckedAt,
  }: { name: string; status: ServiceHealthStatus; lastCheckedAt: string | null } = $props()
</script>

<div class="min-w-0">
  <p class="truncate font-medium text-slate-900">{name}</p>
  <p class="text-xs text-slate-500">{formatCheckedAt(lastCheckedAt)}</p>
</div>
<!-- Story 28.7 AC5/AC6/AC8: badge label and styling are both gated on `lastCheckedAt` — a
     never-checked endpoint renders one honest "pending first check" state instead of a
     contradictory real status badge; once a real check has run, this renders exactly as before. -->
<span
  class={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${statusBadgeClass(status, lastCheckedAt)}`}
>
  {statusBadgeLabel(status, lastCheckedAt)}
</span>
