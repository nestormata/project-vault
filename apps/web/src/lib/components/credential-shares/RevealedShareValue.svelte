<script lang="ts">
  // Shared by both reveal pages — the revealed-value display is identical regardless of
  // recipient type.
  let { value, valueFormat = 'scalar' }: { value: string; valueFormat?: 'scalar' | 'fields' } =
    $props()

  type DisplayField = { key: string; value: string }

  function displayFields(raw: string): DisplayField[] | null {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const fields = parsed.filter(
          (entry): entry is { key: string; value: unknown } =>
            typeof entry === 'object' &&
            entry !== null &&
            'key' in entry &&
            typeof entry.key === 'string' &&
            'value' in entry
        )
        if (fields.length !== parsed.length) return null
        return fields.map(({ key, value: fieldValue }) => ({
          key,
          value: typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue),
        }))
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return Object.entries(parsed).map(([key, fieldValue]) => ({
          key,
          value: typeof fieldValue === 'string' ? fieldValue : JSON.stringify(fieldValue),
        }))
      }
    } catch {
      // Legacy scalar values and malformed payloads remain readable below.
    }
    return null
  }

  const fields = $derived(valueFormat === 'fields' ? displayFields(value) : null)
</script>

<div class="mt-4">
  <p class="mb-1 text-sm font-medium text-slate-700">Value</p>
  {#if fields}
    {#if fields.length === 0}
      <p class="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">No values shared.</p>
    {:else}
      <dl class="divide-y divide-slate-200 rounded-lg bg-slate-100 text-sm">
        {#each fields as field (field.key)}
          <div class="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-4">
            <dt aria-label={field.key} class="font-medium text-slate-700">{field.key}</dt>
            <dd aria-label={field.value} class="break-all text-slate-900">
              <code>{field.value}</code>
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
  {:else}
    <code class="block break-all rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-900">
      {value}
    </code>
  {/if}
</div>
