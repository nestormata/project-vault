<script lang="ts">
  import { resolve } from '$app/paths'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageAdminPointProps } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { CAPABILITY_DENIED_HELP_ID, CAPABILITY_DENIED_HELP_TEXT } from './capability-denied.js'
  import type { ServiceRow } from './service-row.js'

  // Story 69.3: the "Services shown on the public page" card as one replaceable region. It renders
  // only when the page is enabled and the caller can manage it, and the page keeps the selection
  // state (it is shared with disable and the save/reorder handlers) and passes rows and callbacks
  // down. A contribution at `project.status-page.services` receives `{ project, capabilities, serviceEndpoints }`
  // and renders inside the card, after the controls.
  let {
    project,
    capabilities,
    projectId,
    serviceEndpoints,
    rows,
    selectedCount,
    capabilityDenied,
    isBusy,
    onToggle,
    onSetDisplayName,
    onMove,
    onSave,
    data,
  }: {
    project: StatusPageAdminPointProps['project']
    capabilities: StatusPageAdminPointProps['capabilities']
    projectId: string
    serviceEndpoints: StatusPageAdminPointProps['serviceEndpoints']
    rows: ServiceRow[]
    selectedCount: number
    capabilityDenied: boolean
    isBusy: boolean
    onToggle: (service: { id: string; name: string }) => void
    onSetDisplayName: (serviceId: string, displayName: string) => void
    onMove: (index: number, direction: -1 | 1) => void | Promise<void>
    onSave: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.services -->
<div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-xl font-semibold text-slate-950">Services shown on the public page</h2>
  {#if rows.length > 0}
    <p class="text-sm text-slate-600">
      Check a service to publish it and edit its public display name. Selected services are listed
      first, in the order they'll appear — use the keyboard-operable move buttons to reorder them
      when more than one is selected.
    </p>
    <ol aria-label="Services shown on the public page" class="space-y-3">
      {#each rows as row (row.id)}
        <li class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 p-3">
          <label class="flex min-w-[12rem] items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(row.current)}
              onchange={() => onToggle({ id: row.id, name: row.label })}
              aria-describedby={`status-page-service-help-${row.id}`}
            />
            <span class="text-sm text-slate-600">{row.label}</span>
          </label>

          <div class="flex min-w-0 flex-1 items-center gap-2">
            {#if row.current}
              <input
                class="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                type="text"
                placeholder="Public display name"
                value={row.current.displayName}
                aria-describedby={`status-page-display-name-help-${row.id}`}
                oninput={(event) =>
                  onSetDisplayName(row.id, (event.currentTarget as HTMLInputElement).value)}
              />
              <FormHelpText id={`status-page-display-name-help-${row.id}`} kind="text" />
            {/if}
          </div>

          <div class="flex shrink-0 items-center gap-1">
            {#if row.current && selectedCount > 1}
              <button
                class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                aria-label={`Move ${row.label} up`}
                disabled={isBusy || row.index === 0}
                onclick={() => onMove(row.index, -1)}
              >
                ↑
              </button>
              <button
                class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                aria-label={`Move ${row.label} down`}
                disabled={isBusy || row.index === selectedCount - 1}
                onclick={() => onMove(row.index, 1)}
              >
                ↓
              </button>
            {/if}
          </div>

          <FormHelpText id={`status-page-service-help-${row.id}`} kind="checkbox" />
        </li>
      {/each}
    </ol>
  {/if}
  {#if serviceEndpoints.length === 0}
    <p class="text-slate-600">
      No monitored service endpoints exist for this project yet —
      <a
        class="font-medium text-slate-950 underline"
        href={resolve(`/projects/${projectId}/service-endpoints`)}
      >
        register one first
      </a>
      .
    </p>
  {/if}
  <button
    class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
    type="button"
    disabled={isBusy || capabilityDenied}
    aria-describedby={capabilityDenied ? CAPABILITY_DENIED_HELP_ID : undefined}
    onclick={() => onSave()}
  >
    Save services
  </button>
  {#if capabilityDenied}
    <FormHelpText id={CAPABILITY_DENIED_HELP_ID} text={CAPABILITY_DENIED_HELP_TEXT} />
  {/if}<InjectionPoint
    name="project.status-page.services"
    props={{ project, capabilities, serviceEndpoints }}
    {data}
  />
</div>
