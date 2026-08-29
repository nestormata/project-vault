<script lang="ts">
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
  import CrossProjectEmptyState from '$lib/components/dashboard/CrossProjectEmptyState.svelte'
  import DashboardProjectHeading from '$lib/components/dashboard/DashboardProjectHeading.svelte'
  import DashboardPlaceholderGrid from '$lib/components/dashboard/DashboardPlaceholderGrid.svelte'
  import DashboardProjectSelector from '$lib/components/dashboard/DashboardProjectSelector.svelte'
  import {
    getRecentAccessEventLabels,
    getSuggestedActionLabels,
  } from '$lib/components/dashboard/dashboard-copy.js'
  import { formatDateTime } from '$lib/datetime.js'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import RotationBadge from '$lib/components/rotations/RotationBadge.svelte'

  let { data } = $props()

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
</script>

<svelte:head>
  <title>{m.dashboard_page_title()} | Project Vault</title>
</svelte:head>

{#if data.vaultSealed}
  <PageAlertBanner
    title={m.dashboard_vault_sealed_title()}
    message={m.dashboard_vault_sealed_message()}
  />
{:else}
  {#if data.orgDashboard}
    <section class="mb-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">
        {m.dashboard_organization_label()}
      </p>
      <h2 class="mt-2 text-2xl font-bold text-slate-950">
        {m.dashboard_secret_overview_heading()}
      </h2>
      <dl class="mt-4 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">{m.dashboard_total_secrets_label()}</dt>
          <dd class="text-2xl font-bold text-slate-950">{data.orgDashboard.totalCredentials}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">{m.dashboard_expiring_30_days_label()}</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.orgDashboard.expiringWithin30Days.count}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">{m.dashboard_unresolved_alerts_label()}</dt>
          <dd class="text-2xl font-bold text-slate-950">
            {data.orgDashboard.unresolvedAlertCount}
          </dd>
        </div>
      </dl>
      {#if data.orgDashboard.expiringWithin30Days.items.length > 0}
        <div class="mt-5">
          <h3 class="font-semibold text-slate-950">{m.dashboard_expiring_soon_heading()}</h3>
          <ul class="mt-3 space-y-2">
            {#each data.orgDashboard.expiringWithin30Days.items as item (item.id)}
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
      {/if}
    </section>
  {/if}

  {#if data.selectedProject && data.dashboard}
    <div class="space-y-6">
      <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <DashboardProjectSelector projects={data.projects} selectedProject={data.selectedProject} />
        <DashboardProjectHeading
          project={data.selectedProject}
          linked={true}
          showDescription={true}
        />
        <dl class="mt-5 grid gap-3 sm:grid-cols-3">
          <div class="rounded-2xl bg-slate-50 p-4">
            <dt class="text-sm text-slate-500">{m.dashboard_secrets_label()}</dt>
            <dd class="text-2xl font-bold text-slate-950">
              {data.dashboard.credentialStats.active}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-50 p-4">
            <dt class="text-sm text-slate-500">{m.dashboard_expiring_soon_heading()}</dt>
            <dd class="text-2xl font-bold text-slate-950">
              {data.dashboard.credentialStats.expiringSoon}
            </dd>
          </div>
          <div class="rounded-2xl bg-slate-50 p-4">
            <dt class="text-sm text-slate-500">{m.dashboard_alerts_label()}</dt>
            <dd class="text-2xl font-bold text-slate-950">{data.dashboard.unresolvedAlertCount}</dd>
          </div>
          <div class="rounded-2xl bg-slate-50 p-4">
            <dt class="text-sm text-slate-500">{m.dashboard_monitored_services_label()}</dt>
            <dd class="text-lg font-bold text-slate-950">
              {m.dashboard_service_health_summary({
                healthy: data.dashboard.monitoredServiceHealth.healthy,
                degraded: data.dashboard.monitoredServiceHealth.degraded,
                down: data.dashboard.monitoredServiceHealth.down,
              })}
            </dd>
          </div>
        </dl>
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">
          {m.dashboard_upcoming_rotations_heading()}
        </h2>
        {#if data.dashboard.upcomingRotations.length === 0}
          <p class="mt-3 text-sm text-slate-600">{m.dashboard_no_rotations_message()}</p>
        {:else}
          <ul class="mt-4 space-y-2">
            {#each data.dashboard.upcomingRotations as rotation (rotation.credentialId)}
              <li
                class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
              >
                <a
                  class="font-semibold text-slate-950 underline"
                  href={resolve(
                    `/projects/${data.selectedProject.id}/credentials/${rotation.credentialId}`
                  )}
                >
                  {rotation.credentialName}
                </a>
                {#if rotation.status === 'active' && rotation.activeRotation}
                  <!-- Story 18.5 AC-2/AC-6/AC-7: a credential whose current rotation is
                       badge-worthy (non-terminal) — reuses the same rotation-detail link pattern
                       as the credential list and credential detail page's activeRotationId link. -->
                  <RotationBadge
                    status={rotation.activeRotation.status}
                    href={`/projects/${data.selectedProject.id}/credentials/${rotation.credentialId}/rotations/${rotation.activeRotation.rotationId}`}
                  />
                {:else}
                  {#if rotation.scheduledAt}
                    <span class="text-slate-600">{formatDate(rotation.scheduledAt)}</span>
                  {/if}
                  {#if rotation.status === 'overdue'}
                    <span
                      class="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800"
                    >
                      {m.dashboard_rotation_overdue()}
                    </span>
                  {:else}
                    <span
                      class="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                    >
                      {m.dashboard_rotation_scheduled()}
                    </span>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">
          {m.dashboard_recent_activity_heading()}
        </h2>
        {#if data.dashboard.recentAccessEvents.length === 0}
          <p class="mt-3 text-sm text-slate-600">{m.dashboard_no_recent_activity_message()}</p>
        {:else}
          <ul class="mt-4 space-y-2">
            {#each data.dashboard.recentAccessEvents as event, index (`${event.credentialId}-${event.eventType}-${event.occurredAt}-${index}`)}
              <li
                class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
              >
                <div>
                  <a
                    class="font-semibold text-slate-950 underline"
                    href={resolve(
                      `/projects/${data.selectedProject.id}/credentials/${event.credentialId}`
                    )}
                  >
                    {event.credentialName}
                  </a>
                  <span class="ml-2 text-slate-600"
                    >{getRecentAccessEventLabels()[event.eventType]}</span
                  >
                  <span class="ml-2 text-slate-500">{m.dashboard_activity_by_connector()}</span>
                  <span class="text-slate-500">{event.actorDisplayName}</span>
                </div>
                <span class="text-slate-600">{formatDateTime(event.occurredAt)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <DashboardPlaceholderGrid
        hasCredentials={data.dashboard.credentialStats.active +
          data.dashboard.credentialStats.expiringSoon +
          data.dashboard.credentialStats.expired >
          0}
        hasServices={data.dashboard.monitoredServiceHealth.healthy +
          data.dashboard.monitoredServiceHealth.degraded +
          data.dashboard.monitoredServiceHealth.down >
          0}
        certificates={data.monitoringAssets?.certificates}
        domains={data.monitoringAssets?.domains}
      />

      {#if data.dashboard.suggestedActions.length > 0}
        <section class="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 class="font-semibold">{m.dashboard_suggested_actions_heading()}</h2>
          <ul class="mt-3 space-y-2 text-sm text-slate-600">
            {#each data.dashboard.suggestedActions as action (action)}
              <li>
                {#if action === 'add_credential' && data.selectedProject}
                  <a
                    class="font-medium text-slate-950 underline"
                    href={resolve(`/projects/${data.selectedProject.id}/credentials/new`)}
                  >
                    {getSuggestedActionLabels()[action]}
                  </a>
                {:else if action === 'add_service' && data.selectedProject}
                  <!-- Deviation from story text's literal "/services/new": monitoredServiceHealth
                       (hasServices/serviceTotal, gating this suggestion) is sourced from
                       service_endpoints (dashboard-stats.ts), not the unrelated billing
                       `services`/PaymentRecord feature — /services/new would never resolve this
                       suggestion since adding a payment record doesn't move serviceTotal off 0. -->
                  <a
                    class="font-medium text-slate-950 underline"
                    href={resolve(`/projects/${data.selectedProject.id}/service-endpoints/new`)}
                  >
                    {getSuggestedActionLabels()[action]}
                  </a>
                {:else if action === 'import_credentials' && data.selectedProject}
                  <a
                    class="font-medium text-slate-950 underline"
                    href={resolve(`/projects/${data.selectedProject.id}/credentials/import`)}
                  >
                    {getSuggestedActionLabels()[action]}
                  </a>
                {:else}
                  {getSuggestedActionLabels()[action]}
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  {:else if data.selectedProject}
    <div class="space-y-6">
      <section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <DashboardProjectSelector projects={data.projects} selectedProject={data.selectedProject} />
        <DashboardProjectHeading project={data.selectedProject} />
        <p class="mt-4 text-sm text-amber-700" role="status">
          {m.dashboard_summary_unavailable_message()}
        </p>
        <div class="mt-5 rounded-2xl bg-amber-50 p-4">
          <dt class="text-sm text-amber-800">{m.dashboard_alerts_label()}</dt>
          <dd class="mt-1 text-sm font-semibold text-amber-900">
            {m.dashboard_unavailable_right_now()}
          </dd>
        </div>
      </section>
      <DashboardPlaceholderGrid
        hasCredentials={true}
        hasServices={true}
        certificates={data.monitoringAssets?.certificates}
        domains={data.monitoringAssets?.domains}
      />
    </div>
  {:else}
    <div class="space-y-6">
      <CrossProjectEmptyState />
      <DashboardPlaceholderGrid hasCredentials={false} hasServices={false} />
    </div>
  {/if}
{/if}
