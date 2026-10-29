<!--
  @pv-stable: the props contract ({ id, label, value (bindable), type, hint, helpId, error,
  required, autocomplete, disabled }) is final (Story 72.3). A labelled single-line input.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'
  import Field from './Field.svelte'
  import { TEXT_CONTROL_CLASS } from './control-classes.js'

  let {
    id,
    label,
    value = $bindable(''),
    name,
    type = 'text',
    hint,
    helpId,
    error,
    required = false,
    autocomplete,
    disabled = false,
  }: {
    id: string
    label: string
    value?: string
    name?: string
    type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
    hint?: string
    helpId?: string
    error?: string
    required?: boolean
    autocomplete?: HTMLInputAttributes['autocomplete']
    disabled?: boolean
  } = $props()
</script>

<Field {id} {label} {hint} {helpId} {error}>
  {#snippet children(wiring)}
    <input
      class={TEXT_CONTROL_CLASS}
      {id}
      {name}
      {type}
      {autocomplete}
      bind:value
      {required}
      {disabled}
      aria-invalid={wiring.invalid}
      aria-describedby={wiring.describedBy}
    />
  {/snippet}
</Field>
