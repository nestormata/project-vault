<script lang="ts">
  // Story 13.2 — the add/rename/remove field-list editor, shared by the create form and the
  // credential detail edit flow so the two never drift.
  // Story 72.10 — each field has a type: text, multiline, or a one-time password (a write-only
  // seed; the server derives the codes). A one-time password is always sensitive.
  import type { FieldKind } from '@project-vault/shared'
  import type { FieldDraft } from '$lib/components/onboarding/onboarding-logic.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'

  let {
    fields = $bindable(),
    errors = {},
    multilineValue = false,
    onAdd,
    onRemove,
  }: {
    fields: FieldDraft[]
    errors?: Record<number, string>
    multilineValue?: boolean
    onAdd: () => void
    onRemove: (index: number) => void
  } = $props()

  function kindOf(field: FieldDraft): FieldKind {
    return field.kind ?? 'text'
  }

  function setKind(field: FieldDraft, next: FieldKind): void {
    field.kind = next === 'text' ? undefined : next
    if (next === 'totp') field.sensitive = true
  }

  function seedPlaceholder(field: FieldDraft): string {
    return field.storedSeed
      ? m.credential_field_totp_seed_keep()
      : m.credential_field_totp_seed_placeholder()
  }
</script>

{#each fields as field, index (index)}
  <div class="space-y-1 rounded-xl border border-slate-200 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <input
        class="flex-1 rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-2 text-sm"
        type="text"
        placeholder="field name"
        aria-label={`Field ${index + 1} name`}
        aria-describedby={`credential-field-name-help-${index}`}
        bind:value={field.key}
      />
      <select
        class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-2 text-sm"
        aria-label={`${m.credential_field_kind_label()} ${index + 1}`}
        aria-describedby={`credential-field-kind-help-${index}`}
        value={kindOf(field)}
        onchange={(event) => setKind(field, event.currentTarget.value as FieldKind)}
      >
        <option value="text">{m.credential_field_kind_text()}</option>
        <option value="multiline">{m.credential_field_kind_multiline()}</option>
        <option value="totp">{m.credential_field_kind_totp()}</option>
      </select>
      {#if kindOf(field) === 'multiline' || (multilineValue && kindOf(field) === 'text')}
        <textarea
          class="min-h-32 flex-1 rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-2 font-mono text-sm"
          placeholder="value"
          aria-label={`Field ${index + 1} value`}
          aria-describedby={`credential-field-value-help-${index}`}
          bind:value={field.value}></textarea>
      {:else}
        <input
          class="flex-1 rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-2 font-mono text-sm"
          type={field.sensitive || kindOf(field) === 'totp' ? 'password' : 'text'}
          placeholder={kindOf(field) === 'totp' ? seedPlaceholder(field) : 'value'}
          aria-label={`Field ${index + 1} value`}
          autocomplete="new-password"
          aria-describedby={`credential-field-value-help-${index}`}
          bind:value={field.value}
        />
      {/if}
      <label class="flex items-center gap-1 text-xs text-slate-700">
        <input
          type="checkbox"
          aria-describedby={`credential-field-sensitive-help-${index}`}
          disabled={kindOf(field) === 'totp'}
          checked={field.sensitive || kindOf(field) === 'totp'}
          onchange={(event) => (field.sensitive = event.currentTarget.checked)}
        />
        Sensitive
      </label>
      <FormHelpText id={`credential-field-name-help-${index}`} kind="text" />
      <FormHelpText
        id={`credential-field-kind-help-${index}`}
        text={m.credential_field_kind_help()}
      />
      <FormHelpText
        id={`credential-field-value-help-${index}`}
        text={kindOf(field) === 'totp' ? m.credential_field_totp_seed_help() : undefined}
        kind="secret"
      />
      <FormHelpText id={`credential-field-sensitive-help-${index}`} kind="checkbox" />
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
  class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-2 text-sm font-medium"
  type="button"
  onclick={onAdd}
>
  + Add field
</button>
