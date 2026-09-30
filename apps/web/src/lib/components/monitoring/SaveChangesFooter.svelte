<!--
  The tail of every monitored-asset edit form: the submit-error banner followed by the
  save/cancel row. All four asset types' edit forms use the same "Save changes"/"Saving…" copy,
  so this is the one place that's declared.
-->
<script lang="ts">
  import type { ProjectPath } from '$lib/app-paths.js'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import FormErrorBanner from './FormErrorBanner.svelte'

  let {
    errorMessage,
    cancelHref,
    submitting,
  }: {
    errorMessage: string | null
    cancelHref: ProjectPath
    submitting: boolean
  } = $props()
</script>

<FormErrorBanner message={errorMessage} />

<FormSubmitRow submitLabel="Save changes" pendingLabel="Saving…" {cancelHref} {submitting} />
