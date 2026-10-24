<script lang="ts">
  import { getEventTypeLabel } from '$lib/utils/event-type-labels.js'
  import type { AuditEventItem } from '$lib/api/audit.js'
  import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'
  import AuditActorAttribution from './AuditActorAttribution.svelte'

  // Story 69.12: one event row and, when it is the open one, its detail row. Both rows stay siblings
  // in the table body, so this component carries no injection point of its own: the actor cell hosts
  // `settings.audit.results-attribution` and the rows region closes after the whole table.
  let {
    event,
    expanded,
    onToggle,
    pointProps,
    data,
  }: {
    event: AuditEventItem
    expanded: boolean
    onToggle: () => void
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<tr
  class="cursor-pointer border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
  onclick={onToggle}
>
  <td class="px-4 py-3 font-medium text-slate-900">{getEventTypeLabel(event.eventType)}</td>
  <td class="px-4 py-3 text-slate-600"
    >{event.actorDisplayName}<AuditActorAttribution {event} {pointProps} {data} /></td
  >
  <td class="px-4 py-3 text-slate-600">{event.resourceType ?? '—'}</td>
  <td class="px-4 py-3 text-slate-600">{event.projectId ?? '—'}</td>
  <td class="px-4 py-3 text-slate-600">{event.ipAddress ?? '—'}</td>
  <td class="px-4 py-3 text-slate-600">{new Date(event.createdAt).toLocaleString()}</td>
</tr>
{#if expanded}
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
