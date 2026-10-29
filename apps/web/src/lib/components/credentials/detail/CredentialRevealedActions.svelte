<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialValueController } from './credential-value-controller.svelte.js'

  // Story 72.8: the Copy, Hide and Extend buttons under a revealed single value. A helper of the
  // single-value region (no region of its own); the state it reads and writes is the controller's.
  // Extend is a NEW server reveal, so it re-authorizes and writes a new audit row.
  let { controller }: { controller: CredentialValueController } = $props()
</script>

<div class="mt-3 flex gap-3">
  <button
    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium"
    type="button"
    aria-describedby="credential-copy-revealed-help"
    onclick={() => void controller.copyValue()}
  >
    {m.credential_copy_revealed_label()}
  </button>
  <button
    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium"
    type="button"
    onclick={() => controller.hideValue()}
  >
    Hide
  </button>
  <button
    class="rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-4 py-2 text-sm font-medium disabled:opacity-60"
    type="button"
    aria-describedby="credential-reveal-auto-hide-help"
    disabled={controller.revealing}
    onclick={() => void controller.extendValue()}
  >
    {m.credential_reveal_extend()}
  </button>
</div>
