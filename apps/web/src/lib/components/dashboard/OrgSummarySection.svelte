<script lang="ts">
  import { resolve } from '$app/paths'
  import type { getOrgDashboard } from '$lib/api/dashboard.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import StatTile from '$lib/components/StatTile.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { formatDate } from '$lib/datetime.js'

  // Story 69.1: the organization summary (totals and the expiring-soon list) as one replaceable
  // region. It receives no point props: the figures are its own source, never handed to a contribution.
  let {
    orgDashboard,
    data,
  }: {
    orgDashboard: Awaited<ReturnType<typeof getOrgDashboard>>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.org-summary -->
<section class="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
    {m.dashboard_organization_label()}
  </p>
  <h2 class="mt-2 text-2xl font-bold text-slate-950">
    {m.dashboard_secret_overview_heading()}
  </h2>
  <dl class="mt-4 grid gap-3 sm:grid-cols-3">
    <StatTile label={m.dashboard_total_secrets_label()}>{orgDashboard.totalCredentials}</StatTile>
    <StatTile label={m.dashboard_expiring_30_days_label()}>
      {orgDashboard.expiringWithin30Days.count}
    </StatTile>
    <StatTile label={m.dashboard_unresolved_alerts_label()}>
      {orgDashboard.unresolvedAlertCount}
    </StatTile>
  </dl>
  {#if orgDashboard.expiringWithin30Days.items.length > 0}
    <div class="mt-5">
      <h3 class="font-semibold text-slate-950">{m.dashboard_expiring_soon_heading()}</h3>
      <ul class="mt-3 space-y-2">
        {#each orgDashboard.expiringWithin30Days.items as item (item.id)}
          <li
            class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
          >
            <div>
              <a
                class="font-semibold text-slate-950 underline"
                href={resolve(`/projects/${item.projectId}/credentials/${item.id}`)}
              >
                {item.name}
              </a>
              <span class="ml-2 text-slate-500">{item.projectName}</span>
            </div>
            <span class="text-slate-600"
              >{m.dashboard_expires_label({ date: formatDate(item.expiresAt) })}</span
            >
          </li>
        {/each}
      </ul>
    </div>
  {/if}<InjectionPoint name="dashboard.home.org-summary" {data} />
</section>
