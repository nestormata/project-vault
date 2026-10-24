<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { AuditSearchRegionProps } from './audit-region-props.js'

  // Story 69.12: the event type filter of the settings audit search form.
  let { filters, pointProps, data }: AuditSearchRegionProps = $props()
</script>

<!-- @region settings.audit.search-event -->
<RegionFragment>
  <label class="flex flex-col text-sm text-slate-700" for="filter-eventType">
    Event type
    <input
      id="filter-eventType"
      name="eventType"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.eventType ?? ''}
      aria-describedby="audit-event-type-help"
    />
    <FormHelpText id="audit-event-type-help" text={m.form_help_audit_event_type()} />
  </label><InjectionPoint name="settings.audit.search-event" props={pointProps} {data} />
</RegionFragment>
