<script lang="ts">
  import { statusClass, formatCheckedAt, type ServiceHealthStatus } from './service-status'

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
<span class={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${statusClass(status)}`}>
  {status}
</span>
