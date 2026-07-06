<!--
  The check-frequency select + failure-threshold number field, identical between the
  service-endpoint create and edit forms.
-->
<script lang="ts">
  import FieldInput from './FieldInput.svelte'
  import FieldSelect from './FieldSelect.svelte'

  let {
    frequencyOptions,
    checkFrequencyMinutes = $bindable(),
    downThresholdFailures = $bindable(),
  }: {
    frequencyOptions: readonly number[]
    checkFrequencyMinutes: number
    downThresholdFailures: number
  } = $props()
</script>

<FieldSelect
  id="endpoint-frequency"
  label="Check frequency (minutes)"
  options={frequencyOptions}
  bind:value={checkFrequencyMinutes}
/>
<FieldInput
  id="endpoint-threshold"
  label="Failures before &quot;down&quot; (1-10)"
  type="number"
  min={1}
  max={10}
  bind:value={downThresholdFailures}
/>
