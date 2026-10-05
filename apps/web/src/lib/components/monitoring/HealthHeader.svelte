<script lang="ts">
  import type { getHealthDashboard } from '$lib/api/health-dashboard.js'
  import type { Snippet } from 'svelte'

  let {
    hasAnyServices,
    summary,
    children,
  }: {
    hasAnyServices: boolean
    summary: Awaited<ReturnType<typeof getHealthDashboard>>['summary']
    children?: Snippet
  } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Health</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Cross-project health</h1>
  <p class="mt-2 text-slate-600">
    Live status for every monitored service across your organization's projects.
  </p>

  {#if hasAnyServices}
    <dl class="mt-5 grid gap-3 sm:grid-cols-3">
      <div class="rounded-2xl bg-emerald-50 p-4">
        <dt class="text-sm text-emerald-700">Healthy</dt>
        <dd class="text-2xl font-bold text-emerald-900">{summary.healthy}</dd>
      </div>
      <div class="rounded-2xl bg-amber-50 p-4">
        <dt class="text-sm text-amber-700">Degraded</dt>
        <dd class="text-2xl font-bold text-amber-900">{summary.degraded}</dd>
      </div>
      <div class="rounded-2xl bg-red-50 p-4">
        <dt class="text-sm text-red-700">Down</dt>
        <dd class="text-2xl font-bold text-red-900">{summary.down}</dd>
      </div>
    </dl>
  {/if}
</div>
{@render children?.()}
