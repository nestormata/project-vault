<script lang="ts">
  import type { ProjectDashboard, ProjectSummary } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { formatDateTime } from '$lib/datetime.js'
  import { m } from '$lib/paraglide/messages.js'
  import DashboardListSection from './DashboardListSection.svelte'
  import { getRecentAccessEventLabels } from './dashboard-copy.js'

  // Story 69.1: the "Recent activity" card as one replaceable region. It receives `{ project }`
  // (the selected project) and nothing else; `events` is its source, never handed to a contribution.
  let {
    project,
    events,
    data,
  }: {
    project: ProjectSummary
    events: ProjectDashboard['recentAccessEvents']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.activity -->
<DashboardListSection heading={m.dashboard_recent_activity_heading()}>
  {#if events.length === 0}
    <p class="mt-3 text-sm text-slate-600">{m.dashboard_no_recent_activity_message()}</p>
  {:else}
    <ul class="mt-4 space-y-2">
      {#each events as event, index (`${event.credentialId}-${event.eventType}-${event.occurredAt}-${index}`)}
        <li
          class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
        >
          <div>
            <a
              class="font-semibold text-slate-950 underline"
              href={resolve(`/projects/${project.id}/credentials/${event.credentialId}`)}
            >
              {event.credentialName}
            </a>
            <span class="ml-2 text-slate-600">{getRecentAccessEventLabels()[event.eventType]}</span>
            <span class="ml-2 text-slate-500">{m.dashboard_activity_by_connector()}</span>
            <span class="text-slate-500">{event.actorDisplayName}</span>
          </div>
          <span class="text-slate-600">{formatDateTime(event.occurredAt)}</span>
        </li>
      {/each}
    </ul>
  {/if}<InjectionPoint name="dashboard.home.activity" props={{ project }} {data} />
</DashboardListSection>
