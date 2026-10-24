<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'

  // Story 69.12: the submit row of the new project form (the form's own submit handler runs it).
  let {
    submitting,
    data,
  }: {
    submitting: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.new.submit -->
<RegionFragment>
  <FormSubmitRow
    submitLabel="Create project"
    pendingLabel="Creating..."
    cancelHref="/projects"
    {submitting}
  /><InjectionPoint name="project.new.submit" {data} />
</RegionFragment>
