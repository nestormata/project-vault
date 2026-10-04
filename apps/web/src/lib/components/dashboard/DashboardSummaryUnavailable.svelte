<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { ProjectSummary } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import DashboardProjectHeading from './DashboardProjectHeading.svelte'
  import DashboardProjectSelector from './DashboardProjectSelector.svelte'

  // Story 69.1: the card shown when the selected project's summary could not be loaded, as one
  // replaceable region. It receives `{ project }` (the selected project) and nothing else. The
  // `<dt>`/`<dd>` pair sits outside any `<dl>` on purpose: the markup is moved verbatim.
  let {
    project,
    projects,
    data,
  }: {
    project: ProjectSummary
    projects: ComponentProps<typeof DashboardProjectSelector>['projects']
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region dashboard.home.summary-unavailable -->
<section class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <DashboardProjectSelector {projects} selectedProject={project} />
  <DashboardProjectHeading {project} /><InjectionPoint
    name="dashboard.home.summary-unavailable"
    props={{ project }}
    {data}
  />
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
