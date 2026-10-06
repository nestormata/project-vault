<script lang="ts">
  import type { Snippet } from 'svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import AuditPaginationControls from '$lib/components/audit/AuditPaginationControls.svelte'
  import { buildPageHref } from '$lib/audit/page-href.js'
  import { occurredAtDisplay } from '$lib/audit/attribution.js'
  import { m } from '$lib/paraglide/messages.js'
  import { getEventTypeLabel } from '$lib/utils/event-type-labels.js'
  import type { AuditEventItem } from '$lib/api/audit.js'
  import type { SettingsAuditResultsPointProps } from '$lib/components/composition/injection-points.js'

  // Story 69.4: the event table, its empty state and the pagination of the settings audit page.
  // `children` is the page's `settings.audit.results` injection point, rendered last inside the
  // results container.
  let {
    events,
    filters,
    hasFilters,
    page,
    total,
    hasNext,
    children,
  }: {
    events: readonly AuditEventItem[]
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    hasFilters: boolean
    page: number
    total: number
    hasNext: boolean
    children?: Snippet
  } = $props()

  let expandedRowId = $state<string | null>(null)

  function toggleRow(id: string) {
    expandedRowId = expandedRowId === id ? null : id
  }

  // AC-B1 — pagination controls reflecting total/page/hasNext, preserving whatever filters are
  // already active so paging never silently drops the current search.
  const pageHref = $derived(buildPageHref(filters))
</script>

<div class="mt-4">
  {#if events.length === 0}
    <p class="py-6 text-center text-slate-600">
      {hasFilters ? 'No audit events match these filters.' : 'No audit events yet.'}
    </p>
  {:else}
    <DataTable columns={['Event type', 'Actor', 'Resource', 'Project', 'IP address', 'Created at']}>
      {#each events as event (event.id)}
        <tr
          class="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
          onclick={() => toggleRow(event.id)}
        >
          <td class="px-4 py-3 font-medium text-slate-900">{getEventTypeLabel(event.eventType)}</td>
          <td class="px-4 py-3 text-slate-600"
            >{event.actorDisplayName}{#if event.attribution}
              {@const actor = event.attribution.actor}
              {@const occurred = occurredAtDisplay(event.createdAt, event.attribution)}
              {#if actor?.kind === 'issuer_attested'}
                <!-- Never the actor-name position or typography: provider next to subject, in words. -->
                <span
                  data-testid="actor-attestation"
                  class="mt-1 block max-w-xs rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs break-all text-slate-800"
                >
                  <strong class="font-semibold">{m.audit_attr_badge_issuer()}</strong>
                  <span class="block italic"
                    >{m.audit_attr_identity({
                      provider: actor.provider,
                      subject: actor.subject,
                    })}</span
                  >
                  <span class="block"
                    >{actor.reason === 'not_current_member'
                      ? m.audit_attr_reason_not_member()
                      : m.audit_attr_reason_unlinked()}</span
                  >
                </span>
              {:else if actor?.kind === 'pv_verified'}
                <span data-testid="actor-delegated" class="mt-1 block text-xs text-slate-500"
                  >{m.audit_attr_verified_delegated()}</span
                >
              {/if}
              {#if occurred}
                <span data-testid="actor-occurred" class="mt-1 block text-xs text-slate-500"
                  >{occurred.signed
                    ? m.audit_attr_occurred_signed({ time: occurred.time })
                    : m.audit_attr_occurred_declared({ time: occurred.time })}</span
                >
              {/if}
            {/if}</td
          >
          <td class="px-4 py-3 text-slate-600">{event.resourceType ?? '—'}</td>
          <td class="px-4 py-3 text-slate-600">{event.projectId ?? '—'}</td>
          <td class="px-4 py-3 text-slate-600">{event.ipAddress ?? '—'}</td>
          <td class="px-4 py-3 text-slate-600">{new Date(event.createdAt).toLocaleString()}</td>
        </tr>
        {#if expandedRowId === event.id}
          <tr class="border-b border-slate-100 bg-slate-50 last:border-b-0">
            <td colspan="6" class="px-4 py-3 text-sm text-slate-700">
              <dl class="grid grid-cols-2 gap-2">
                <dt class="font-medium">Resource ID</dt>
                <dd>{event.resourceId ?? '—'}</dd>
                <dt class="font-medium">Resource type</dt>
                <dd>{event.resourceType ?? '—'}</dd>
                <dt class="font-medium">Project</dt>
                <dd>{event.projectId ?? '—'}</dd>
                <dt class="font-medium">IP address</dt>
                <dd>{event.ipAddress ?? '—'}</dd>
                <dt class="font-medium">Actor</dt>
                <dd>{event.actorDisplayName}</dd>
                <dt class="font-medium">Created at</dt>
                <dd>{event.createdAt}</dd>
              </dl>
            </td>
          </tr>
        {/if}
      {/each}
    </DataTable>

    <AuditPaginationControls {page} {total} {hasNext} {pageHref} />
  {/if}{@render children?.()}
</div>
