<!--
  @pv-stable: the props contract ({ id, label, value (bindable), rows, hint, helpId, error, required,
  disabled }) is final (Story 72.3). A labelled multi-line input.
-->
<script lang="ts">
  import Field from './Field.svelte'
  import { TEXT_CONTROL_CLASS } from './control-classes.js'

  let {
    id,
    label,
    value = $bindable(''),
    name,
    rows = 4,
    hint,
    helpId,
    error,
    required = false,
    disabled = false,
  }: {
    id: string
    label: string
    value?: string
    name?: string
    rows?: number
    hint?: string
    helpId?: string
    error?: string
    required?: boolean
    disabled?: boolean
  } = $props()
</script>

<Field {id} {label} {hint} {helpId} {error}>
  {#snippet children(wiring)}
    <textarea
      class={TEXT_CONTROL_CLASS}
      {id}
      {name}
      {rows}
      bind:value
      {required}
      {disabled}
      aria-invalid={wiring.invalid}
      aria-describedby={wiring.describedBy}></textarea>
  {/snippet}
</Field>
