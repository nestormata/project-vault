<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import type {
    InjectionPointExtras,
    SettingsAuditResultsPointProps,
  } from '$lib/components/composition/injection-points.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.12: the resource and project filters of the settings audit search form.
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

<!-- @region settings.audit.search-resource -->
<RegionFragment>
  <label class="flex flex-col text-sm text-slate-700" for="filter-resourceId">
    Resource ID
    <input
      id="filter-resourceId"
      name="resourceId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.resourceId ?? ''}
      aria-describedby="audit-resource-help"
    />
    <FormHelpText id="audit-resource-help" text={m.form_help_audit_resource_id()} />
  </label>
  <label class="flex flex-col text-sm text-slate-700" for="filter-projectId">
    Project ID
    <input
      id="filter-projectId"
      name="projectId"
      type="text"
      class="rounded-lg border border-slate-300 px-2 py-1"
      value={filters?.projectId ?? ''}
      aria-describedby="audit-project-help"
    />
    <FormHelpText id="audit-project-help" text={m.form_help_audit_project_id()} />
  </label><InjectionPoint name="settings.audit.search-resource" props={pointProps} {data} />
</RegionFragment>
