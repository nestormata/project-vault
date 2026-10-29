<!--
  @pv-stable: the props contract ({ id, legend, type, name, options, value (bindable), hint, helpId,
  error, disabled }) is final (Story 72.3). The checkbox or radio group: a fieldset with a legend.
  `type="radio"` binds a string, `type="checkbox"` binds a string array. The hint and error describe
  the whole fieldset; `id` prefixes the item ids (`<id>-<index>`), so every id is explicit.
-->
<script module lang="ts">
  export interface ChoiceOption {
    value: string
    label: string
    disabled?: boolean
  }
</script>

<script lang="ts">
  import FieldMessages from './FieldMessages.svelte'
  import { describedByOf } from './field-ids.js'
  import { CHOICE_CONTROL_CLASS } from './control-classes.js'

  let {
    id,
    legend,
    type,
    name,
    options,
    value = $bindable(),
    hint,
    helpId,
    error,
    disabled = false,
  }: {
    id: string
    legend: string
    type: 'checkbox' | 'radio'
    name: string
    options: readonly ChoiceOption[]
    value?: string | string[]
    hint?: string
    helpId?: string
    error?: string
    disabled?: boolean
  } = $props()

  const describedBy = $derived(describedByOf(id, helpId, hint, error))

  function selected(optionValue: string): boolean {
    return Array.isArray(value) ? value.includes(optionValue) : value === optionValue
  }

  function choose(optionValue: string, checked: boolean) {
    if (type === 'radio') {
      value = optionValue
      return
    }
    const current = Array.isArray(value) ? value : []
    value = checked
      ? [...current.filter((item) => item !== optionValue), optionValue]
      : current.filter((item) => item !== optionValue)
  }
</script>

<fieldset class="space-y-2">
  <legend class="font-medium text-slate-900">{legend}</legend>
  {#each options as option, index (option.value)}
    <label class="flex items-center gap-2" for={`${id}-${index}`}>
      <input
        class={CHOICE_CONTROL_CLASS}
        id={`${id}-${index}`}
        {type}
        {name}
        value={option.value}
        checked={selected(option.value)}
        disabled={disabled || option.disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onchange={(event) => choose(option.value, event.currentTarget.checked)}
      />
      <span>{option.label}</span>
    </label>
  {/each}
  <FieldMessages {id} {hint} {helpId} {error} />
</fieldset>
