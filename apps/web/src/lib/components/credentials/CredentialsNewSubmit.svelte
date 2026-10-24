<script lang="ts">
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.11: the submit row of the new secret form (the form's own submit handler runs it).
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

<!-- @region project.credentials-new.submit -->
<RegionFragment>
  <FormSubmitRow
    submitLabel="Create secret"
    pendingLabel="Creating…"
    cancelHref={`/projects/${projectId}/credentials`}
    {submitting}
  /><InjectionPoint name="project.credentials-new.submit" {data} />
</RegionFragment>
