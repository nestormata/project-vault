<script lang="ts">
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { ServiceRow, ServiceRowCallbacks } from './service-row.js'

  // Story 69.11: one row of the selectable services (checkbox, public display name, move buttons).
  let {
    row,
    selectedCount,
    isBusy,
    onToggle,
    onSetDisplayName,
    onMove,
  }: ServiceRowCallbacks & {
    row: ServiceRow
    selectedCount: number
    isBusy: boolean
  } = $props()
</script>

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
        class="min-w-0 flex-1 rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-sm"
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
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        type="button"
        aria-label={`Move ${row.label} up`}
        disabled={isBusy || row.index === 0}
        onclick={() => onMove(row.index, -1)}
      >
        ↑
      </button>
      <button
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
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
