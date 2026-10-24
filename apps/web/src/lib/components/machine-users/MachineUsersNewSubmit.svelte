<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'

  // Story 69.12: the submit row of the new machine user form (the form's own handler runs it).
  let {
    projectId,
    submitting,
    data,
  }: {
    projectId: string
    submitting: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.machine-users-new.submit -->
<RegionFragment>
  <FormSubmitRow
    submitLabel="Create machine user"
    pendingLabel="Creating…"
    cancelHref={`/projects/${projectId}/machine-users`}
    {submitting}
  /><InjectionPoint name="project.machine-users-new.submit" {data} />
</RegionFragment>
