<script lang="ts">
  // Story 13.2 — the add/rename/remove field-list editor, shared by the create form and the
  // credential detail edit flow so the two never drift.
  import type { FieldDraft } from '$lib/components/onboarding/onboarding-logic.js'

  let {
    fields = $bindable(),
    errors = {},
    onAdd,
    onRemove,
  }: {
    fields: FieldDraft[]
    errors?: Record<number, string>
    onAdd: () => void
    onRemove: (index: number) => void
  } = $props()
</script>

{#each fields as field, index (index)}
  <div class="space-y-1 rounded-xl border border-slate-200 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <input
        class="flex-1 rounded-lg border border-slate-300 px-2 py-2 text-sm"
        type="text"
        placeholder="field name"
        aria-label={`Field ${index + 1} name`}
        bind:value={field.key}
      />
      <input
        class="flex-1 rounded-lg border border-slate-300 px-2 py-2 font-mono text-sm"
        type={field.sensitive ? 'password' : 'text'}
        placeholder="value"
        aria-label={`Field ${index + 1} value`}
        autocomplete="new-password"
        bind:value={field.value}
      />
      <label class="flex items-center gap-1 text-xs text-slate-700">
        <input type="checkbox" bind:checked={field.sensitive} />
        Sensitive
      </label>
      <button
        class="text-sm font-medium text-red-700 underline"
        type="button"
        aria-label={`Remove field ${index + 1}`}
        onclick={() => onRemove(index)}
      >
        Remove
      </button>
    </div>
    {#if errors[index]}
      <p class="text-sm text-red-700" role="alert">{errors[index]}</p>
    {/if}
  </div>
{/each}
<button
  class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium"
  type="button"
  onclick={onAdd}
>
  + Add field
</button>
