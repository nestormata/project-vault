<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { EndpointRowPointProps } from '$lib/components/composition/injection-points.js'
  import { getHealthHistory, type HealthHistoryEntry } from '$lib/api/service-endpoints.js'
  import HealthHistoryEntries from './HealthHistoryEntries.svelte'

  // Story 69.3: the endpoint detail page's "Recent health checks" section as one replaceable region.
  // It owns the paging state (AC-E6: reverse-chronological and paginated, unlike the four list
  // endpoints) and reloads page 1 whenever the endpoint changes. A contribution at
  // `project.service-endpoints-detail.history` receives `{ project, endpoint, orgRole }` and renders inside
  // the section, after PV's own history.
  let {
    project,
    endpoint,
    orgRole,
    projectId,
    data,
  }: {
    project: EndpointRowPointProps['project']
    endpoint: EndpointRowPointProps['endpoint']
    orgRole: EndpointRowPointProps['orgRole']
    projectId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  let historyItems = $state<HealthHistoryEntry[]>([])
  let historyPage = $state(1)
  let historyHasNext = $state(false)
  let historyLoading = $state(false)
  let historyError = $state<string | null>(null)

  $effect(() => {
    void loadHistory(1)
  })

  async function loadHistory(page: number) {
    historyLoading = true
    historyError = null
    try {
      const result = await getHealthHistory(fetch, projectId, endpoint.id, { page })
      historyItems = page === 1 ? result.items : [...historyItems, ...result.items]
      historyHasNext = result.hasNext
      historyPage = page
    } catch (error) {
      historyError = error instanceof Error ? error.message : 'Could not load health history.'
    } finally {
      historyLoading = false
    }
  }
</script>

<!-- @region project.service-endpoints-detail.history -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Recent health checks</h2>
  {#if historyError}
    <p class="mt-3 text-sm text-red-700" role="alert">{historyError}</p>
  {/if}
  {#if historyItems.length === 0 && !historyLoading}
    <p class="mt-3 text-sm text-slate-600">No health checks recorded yet.</p>
  {:else}
    <HealthHistoryEntries items={historyItems} />
    {#if historyHasNext}
      <button
        class="mt-3 text-sm font-medium text-slate-700 underline"
        type="button"
        disabled={historyLoading}
        onclick={() => void loadHistory(historyPage + 1)}
      >
        Load more
      </button>
    {/if}
  {/if}<InjectionPoint
    name="project.service-endpoints-detail.history"
    props={{ project, endpoint, orgRole }}
    {data}
  />
</section>
