<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import Field from '$lib/components/ui/Field.svelte'
  import { TEXT_CONTROL_CLASS } from '$lib/components/ui/control-classes.js'

  // Story 72-9: the links field of the project settings form (one address per line).
  let {
    urlText = $bindable(),
    error,
    data,
  }: {
    urlText: string
    error?: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.settings.urls -->
<div>
  <Field
    id="project-settings-urls"
    label="Links"
    {error}
    hint="One http or https address per line, up to 10. Optional."
  >
    {#snippet children(wiring)}
      <textarea
        class={TEXT_CONTROL_CLASS}
        id="project-settings-urls"
        rows="4"
        bind:value={urlText}
        aria-invalid={wiring.invalid}
        aria-describedby={wiring.describedBy}></textarea>
    {/snippet}
  </Field><InjectionPoint name="project.settings.urls" {data} />
</div>
