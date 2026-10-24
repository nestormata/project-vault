<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type {
    InjectionPointExtras,
    SettingsAuditResultsPointProps,
  } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.12: the actor filters of the settings audit search form (the PV actor id, and the
  // external actor's provider and subject, which are submitted as a pair).
  let {
    filters,
    pointProps,
    data,
  }: {
    filters: SettingsAuditResultsPointProps['filters'] | undefined
    pointProps: InjectionPointExtras<'settings.audit.results'>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region settings.audit.search-actor -->
<RegionFragment>
  <label class="flex flex-col text-sm text-slate-700" for="filter-actorId">
    Actor ID
    <input
      id="filter-actorId"
      name="actorId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.actorId ?? ''}
      aria-describedby="audit-actor-help"
    />
    <FormHelpText id="audit-actor-help" text={m.form_help_audit_actor_id()} />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-actorProvider">
    {m.audit_filter_actor_provider_label()}
    <input
      id="filter-actorProvider"
      name="actorProvider"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.actorProvider ?? ''}
      aria-describedby="audit-actor-provider-help"
    />
    <FormHelpText id="audit-actor-provider-help" text={m.audit_filter_actor_provider_help()} />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-actorSubject">
    {m.audit_filter_actor_subject_label()}
    <input
      id="filter-actorSubject"
      name="actorSubject"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.actorSubject ?? ''}
      aria-describedby="audit-actor-subject-help"
    />
    <FormHelpText id="audit-actor-subject-help" text={m.audit_filter_actor_subject_help()} />
  </label><InjectionPoint name="settings.audit.search-actor" props={pointProps} {data} />
</RegionFragment>
