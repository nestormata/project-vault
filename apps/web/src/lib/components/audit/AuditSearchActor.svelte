<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { AuditSearchRegionProps } from './audit-region-props.js'

  // Story 69.12: the actor filters of the settings audit search form (the PV actor id, and the
  // external actor's provider and subject, which are submitted as a pair).
  let { filters, pointProps, data }: AuditSearchRegionProps = $props()
</script>

<!-- @region settings.audit.search-actor -->
<RegionFragment>
  <div class="flex flex-col text-sm text-slate-700">
    <label for="filter-actorId">Actor ID</label>
    <input
      id="filter-actorId"
      name="actorId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.actorId ?? ''}
      aria-describedby="audit-actor-help"
    />
    <FormHelpText id="audit-actor-help" text={m.form_help_audit_actor_id()} />
  </div>
  <div class="flex flex-col text-sm text-slate-700">
    <label for="filter-actorProvider">{m.audit_filter_actor_provider_label()}</label>
    <input
      id="filter-actorProvider"
      name="actorProvider"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.actorProvider ?? ''}
      aria-describedby="audit-actor-provider-help"
    />
    <FormHelpText id="audit-actor-provider-help" text={m.audit_filter_actor_provider_help()} />
  </div>
  <div class="flex flex-col text-sm text-slate-700">
    <label for="filter-actorSubject">{m.audit_filter_actor_subject_label()}</label>
    <input
      id="filter-actorSubject"
      name="actorSubject"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.actorSubject ?? ''}
      aria-describedby="audit-actor-subject-help"
    />
    <FormHelpText id="audit-actor-subject-help" text={m.audit_filter_actor_subject_help()} />
  </div>
  <InjectionPoint name="settings.audit.search-actor" props={pointProps} {data} />
</RegionFragment>
