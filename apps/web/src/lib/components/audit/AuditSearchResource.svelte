<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import type { AuditSearchRegionProps } from './audit-region-props.js'

  // Story 69.12: the resource and project filters of the settings audit search form.
  let { filters, pointProps, data }: AuditSearchRegionProps = $props()
</script>

<!-- @region settings.audit.search-resource -->
<RegionFragment>
  <div class="flex flex-col text-sm text-slate-700">
    <label for="filter-resourceId">Resource ID</label>
    <input
      id="filter-resourceId"
      name="resourceId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.resourceId ?? ''}
      aria-describedby="audit-resource-help"
    />
    <FormHelpText id="audit-resource-help" text={m.form_help_audit_resource_id()} />
  </div>
  <div class="flex flex-col text-sm text-slate-700">
    <label for="filter-projectId">Project ID</label>
    <input
      id="filter-projectId"
      name="projectId"
      type="text"
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1"
      value={filters?.projectId ?? ''}
      aria-describedby="audit-project-help"
    />
    <FormHelpText id="audit-project-help" text={m.form_help_audit_project_id()} />
  </div>
  <InjectionPoint name="settings.audit.search-resource" props={pointProps} {data} />
</RegionFragment>
