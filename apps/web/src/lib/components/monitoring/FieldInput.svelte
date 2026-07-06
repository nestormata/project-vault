<!--
  A single labeled <input> (text/date/number) plus its optional inline field error, in the shape
  every monitored-asset create/edit form uses. Shared across all four asset types' new/+page.svelte
  and [id]/+page.svelte forms, which otherwise repeat this exact label+input+error block per field.
-->
<script lang="ts">
  let {
    id,
    label,
    type = 'text',
    value = $bindable(),
    error,
    placeholder,
    min,
    max,
  }: {
    id: string
    label: string
    type?: 'text' | 'date' | 'number'
    value: string | number
    error?: string
    placeholder?: string
    min?: number
    max?: number
  } = $props()
</script>

<div class="space-y-2">
  <label class="block font-medium text-slate-900" for={id}>{label}</label>
  <input
    {id}
    class="w-full rounded-xl border border-slate-300 px-3 py-3"
    {type}
    {placeholder}
    {min}
    {max}
    {value}
    oninput={(event) => {
      const raw = event.currentTarget.value
      value = type === 'number' ? Number(raw) : raw
    }}
  />
  {#if error}
    <p class="text-sm text-red-700">{error}</p>
  {/if}
</div>
