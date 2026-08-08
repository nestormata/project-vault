<script lang="ts">
  import * as m from '$lib/paraglide/messages.js'

  let { id = 'cron-schedule-help' }: { id?: string } = $props()
  let open = $state(false)
  let trigger = $state<HTMLButtonElement | null>(null)
  let dialog = $state<HTMLDivElement | null>(null)

  const dialogId = $derived(`${id}-dialog`)
  const titleId = $derived(`${id}-title`)

  $effect(() => {
    if (open) dialog?.focus()
  })

  function openHelp(event: MouseEvent): void {
    trigger = event.currentTarget as HTMLButtonElement
    open = true
  }

  function closeHelp(): void {
    open = false
    trigger?.focus()
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') closeHelp()
  }

  function handleDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !dialog) return
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.hasAttribute('disabled'))
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<button
  class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-100"
  type="button"
  aria-label={m.form_help_rotation_help_label()}
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={dialogId}
  onclick={openHelp}
>
  <span aria-hidden="true">?</span>
</button>

{#if open}
  <div class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" role="presentation">
    <div
      bind:this={dialog}
      id={dialogId}
      class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabindex="-1"
      onkeydown={handleDialogKeydown}
    >
      <div class="flex items-start justify-between gap-4">
        <h2 id={titleId} class="text-lg font-semibold text-slate-950">
          {m.form_help_rotation_help_title()}
        </h2>
        <button
          class="min-h-9 min-w-9 rounded-full text-slate-500 hover:bg-slate-100"
          type="button"
          aria-label={m.form_help_rotation_help_close()}
          onclick={closeHelp}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <ul class="mt-4 space-y-2 text-sm text-slate-700">
        <li>{m.form_help_rotation_help_minute()}</li>
        <li>{m.form_help_rotation_help_hour()}</li>
        <li>{m.form_help_rotation_help_day_of_month()}</li>
        <li>{m.form_help_rotation_help_month()}</li>
        <li>{m.form_help_rotation_help_weekday()}</li>
      </ul>
    </div>
  </div>
{/if}
