<!--
  @pv-stable: the props contract ({ id, label, value (bindable), options, placeholder, hint, helpId,
  error, required, disabled }) is final (Story 72.3). A labelled native select. `placeholder` adds a
  leading option with an empty value (opt-in).
-->
<script lang="ts">
  import Field from './Field.svelte'
  import { TEXT_CONTROL_CLASS } from './control-classes.js'

  export interface SelectOption {
    value: string
    label: string
    disabled?: boolean
  }

  let {
    id,
    label,
    value = $bindable(''),
    options,
    placeholder,
    hint,
    helpId,
    error,
    required = false,
    disabled = false,
  }: {
    id: string
    label: string
    value?: string
    options: readonly SelectOption[]
    placeholder?: string
    hint?: string
    helpId?: string
    error?: string
    required?: boolean
    disabled?: boolean
  } = $props()
</script>

<Field {id} {label} {hint} {helpId} {error}>
  {#snippet children(wiring)}
    <select
      class={TEXT_CONTROL_CLASS}
      {id}
      bind:value
      {required}
      {disabled}
      aria-invalid={wiring.invalid}
      aria-describedby={wiring.describedBy}
    >
      {#if placeholder}
        <option value="">{placeholder}</option>
      {/if}
      {#each options as option (option.value)}
        <option value={option.value} disabled={option.disabled}>{option.label}</option>
      {/each}
    </select>
  {/snippet}
</Field>
