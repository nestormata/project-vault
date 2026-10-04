<script lang="ts">
  import type { ProjectDashboard, ProjectSummary } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { getSuggestedActionLabels } from './dashboard-copy.js'
  import SuggestedActionLink from './SuggestedActionLink.svelte'

  // Story 69.1: the "Suggested actions" card as one replaceable region. It receives `{ project }`
  // (the selected project) and nothing else. A contribution's markup lands at the end of the list,
  // so it should itself be `<li>` shaped.
  let {
    project,
    actions,
    data,
  }: {
    project: ProjectSummary
    actions: ProjectDashboard['suggestedActions']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.suggested-actions -->
<section class="rounded-2xl border border-slate-200 bg-white p-4">
  <h2 class="font-semibold">{m.dashboard_suggested_actions_heading()}</h2>
  <ul class="mt-3 space-y-2 text-sm text-slate-600">
    {#each actions as action (action)}
      <li>
        {#if action === 'add_credential'}
          <SuggestedActionLink
            path={`/projects/${project.id}/credentials/new`}
            label={getSuggestedActionLabels()[action]}
          />
        {:else if action === 'add_service'}
          <!-- Deviation from story text's literal "/services/new": monitoredServiceHealth
               (hasServices/serviceTotal, gating this suggestion) is sourced from
               service_endpoints (dashboard-stats.ts), not the unrelated billing
               `services`/PaymentRecord feature — /services/new would never resolve this
               suggestion since adding a payment record doesn't move serviceTotal off 0. -->
          <SuggestedActionLink
            path={`/projects/${project.id}/service-endpoints/new`}
            label={getSuggestedActionLabels()[action]}
          />
        {:else if action === 'import_credentials'}
          <SuggestedActionLink
            path={`/projects/${project.id}/credentials/import`}
            label={getSuggestedActionLabels()[action]}
          />
        {:else}
          {getSuggestedActionLabels()[action]}
        {/if}
      </li>
    {/each}<InjectionPoint name="dashboard.home.suggested-actions" props={{ project }} {data} />
  </ul>
</section>
