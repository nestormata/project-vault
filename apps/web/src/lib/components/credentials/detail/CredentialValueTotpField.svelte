<script lang="ts">
  import type { FieldMeta } from '@project-vault/shared'
  import { m } from '$lib/paraglide/messages.js'
  import type { CredentialValueController } from './credential-value-controller.svelte.js'

  // Story 72.10: the controls of a one-time-password field. There is no Reveal and no "copy without
  // revealing": the seed is write-only, so the only thing this row can show is the current code,
  // which the server generates (and audits) on request and which hides when its period ends.
  let {
    controller,
    meta,
  }: {
    controller: CredentialValueController
    meta: FieldMeta
  } = $props()

  const shown = $derived(
    Object.hasOwn(controller.totpCodes, meta.key) ? controller.totpCodes[meta.key] : undefined
  )
  const busy = $derived(controller.generatingTotp === meta.key)

  let nowMs = $state(Date.now())
  $effect(() => {
    if (!shown) return
    nowMs = Date.now()
    const timer = setInterval(() => (nowMs = Date.now()), 1000)
    return () => clearInterval(timer)
  })
  const secondsLeft = $derived(
    shown ? Math.max(0, Math.ceil((shown.expiresAtMs - nowMs) / 1000)) : 0
  )
</script>

{#if shown}
  <span
    class="font-mono text-base tracking-widest text-slate-900"
    data-testid={`field-totp-code-${meta.key}`}
    aria-label={m.credential_totp_code_label({ field: meta.key })}>{shown.code}</span
  >
  <span class="text-xs text-slate-600" role="status" aria-live="off"
    >{m.credential_totp_expires({ seconds: String(secondsLeft) })}</span
  >
  <button
    class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium"
    type="button"
    onclick={() => void controller.copyTotp(meta.key)}
  >
    {m.credential_totp_copy({ field: meta.key })}
  </button>
  <button
    class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium"
    type="button"
    onclick={() => controller.hideTotp(meta.key)}
  >
    {m.credential_totp_hide({ field: meta.key })}
  </button>
{:else}
  <span class="text-slate-400" data-testid={`field-masked-${meta.key}`}>••••••</span>
  {#if controller.canReveal}
    <button
      class="rounded-lg border border-[color:var(--color-border-strong,#64748b)] px-2 py-1 text-xs font-medium disabled:opacity-60"
      type="button"
      disabled={busy}
      onclick={() => void controller.generateTotp(meta.key)}
    >
      {busy ? m.credential_totp_generating() : m.credential_totp_show_code({ field: meta.key })}
    </button>
  {/if}
{/if}
