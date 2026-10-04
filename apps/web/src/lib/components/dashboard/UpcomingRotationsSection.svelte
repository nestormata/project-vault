<script lang="ts">
  import type { ProjectDashboard, ProjectSummary } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RotationBadge from '$lib/components/rotations/RotationBadge.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { formatDate } from '$lib/datetime.js'
  import DashboardListSection from './DashboardListSection.svelte'

  // Story 69.1: the "Upcoming rotations" card as one replaceable region. It receives `{ project }`
  // (the selected project) and nothing else; `rotations` is its source, never handed to a contribution.
  let {
    project,
    rotations,
    data,
  }: {
    project: ProjectSummary
    rotations: ProjectDashboard['upcomingRotations']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.rotations -->
<DashboardListSection heading={m.dashboard_upcoming_rotations_heading()}>
  {#if rotations.length === 0}
    <p class="mt-3 text-sm text-slate-600">{m.dashboard_no_rotations_message()}</p>
  {:else}
    <ul class="mt-4 space-y-2">
      {#each rotations as rotation (rotation.credentialId)}
        <li
          class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
        >
          <a
            class="font-semibold text-slate-950 underline"
            href={resolve(`/projects/${project.id}/credentials/${rotation.credentialId}`)}
          >
            {rotation.credentialName}
          </a>
          {#if rotation.status === 'active' && rotation.activeRotation}
            <!-- Story 18.5 AC-2/AC-6/AC-7: a credential whose current rotation is
                 badge-worthy (non-terminal) — reuses the same rotation-detail link pattern
                 as the credential list and credential detail page's activeRotationId link. -->
            <RotationBadge
              status={rotation.activeRotation.status}
              href={`/projects/${project.id}/credentials/${rotation.credentialId}/rotations/${rotation.activeRotation.rotationId}`}
            />
          {:else}
            {#if rotation.scheduledAt}
              <span class="text-slate-600">{formatDate(rotation.scheduledAt)}</span>
            {/if}
            {#if rotation.status === 'overdue'}
              <span class="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">
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
  {/if}<InjectionPoint name="dashboard.home.rotations" props={{ project }} {data} />
</DashboardListSection>
