<script lang="ts">
  // D4/D5 — shared typed-identifier confirmation gate reused identically by the pseudonymize
  // (AC-J) and erasure-execute (AC-L) flows: the caller must type the target's exact email before
  // the parent's own submit control enables. This component renders no submit button and knows
  // nothing about `confirmUserId`/`{ confirm: true }` — those request-shape decisions stay in the
  // parent per D4/D5. The comparison is case-insensitive and trimmed (adversarial review, low) so
  // a legitimate operator isn't permanently blocked by a letter-case difference from stored data.
  let {
    expectedValue,
    onMatchChange,
    label = 'Type the exact email to confirm',
    inputId = 'typed-confirm-input',
  }: {
    expectedValue: string
    onMatchChange: (matches: boolean) => void
    label?: string
    inputId?: string
  } = $props()

  let value = $state('')

  function normalize(input: string): string {
    return input.trim().toLowerCase()
  }

  function handleInput() {
    const matches = value.trim().length > 0 && normalize(value) === normalize(expectedValue)
    onMatchChange(matches)
  }
</script>

<div class="flex flex-col gap-1">
  <label class="text-sm font-medium text-slate-700" for={inputId}>{label}</label>
  <input
    id={inputId}
    type="text"
    class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
    bind:value
    oninput={handleInput}
    autocomplete="off"
  />
</div>
