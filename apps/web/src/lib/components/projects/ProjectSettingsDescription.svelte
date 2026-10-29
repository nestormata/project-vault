<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import Field from '$lib/components/ui/Field.svelte'
  import { TEXT_CONTROL_CLASS } from '$lib/components/ui/control-classes.js'

  // Story 72-9: the description field of the project settings form. The form owns the value.
  let {
    description = $bindable(),
    error,
    data,
  }: {
    description: string
    error?: string | undefined
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.settings.description -->
<div>
  <Field
    id="project-settings-description"
    label="Description"
    {error}
    hint="Up to 512 characters. Optional."
  >
    {#snippet children(wiring)}
      <textarea
        class={TEXT_CONTROL_CLASS}
        id="project-settings-description"
        rows="3"
        maxlength="512"
        bind:value={description}
        aria-invalid={wiring.invalid}
        aria-describedby={wiring.describedBy}></textarea>
    {/snippet}
  </Field><InjectionPoint name="project.settings.description" {data} />
</div>
