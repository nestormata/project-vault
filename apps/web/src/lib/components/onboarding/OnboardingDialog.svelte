<script lang="ts">
  import { trapFocus } from './focus-trap.js'

  let {
    dialogRef = $bindable<HTMLElement | null>(null),
    labelledby,
    onClose,
    children,
  }: {
    dialogRef?: HTMLElement | null
    labelledby: string
    onClose: () => void
    children: import('svelte').Snippet
  } = $props()

  $effect(() => {
    if (!dialogRef) return
    return trapFocus(dialogRef)
  })

  // AC-6: standard modal keyboard behavior — Escape closes the dialog via the same handler as
  // the visible close button (AC-5), regardless of which step is currently shown.
  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }
</script>

<div
  bind:this={dialogRef}
  class="fixed inset-0 z-50 flex max-h-[100dvh] items-start justify-center overflow-y-auto bg-slate-950/70 p-4 sm:items-center"
  role="dialog"
  aria-modal="true"
  aria-labelledby={labelledby}
  tabindex="-1"
  onkeydown={onKeydown}
>
  <div class="relative my-auto w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl sm:p-8">
    <button
      class="absolute right-3 top-3 flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      type="button"
      aria-label="Close"
      onclick={onClose}
    >
      <svg aria-hidden="true" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
          clip-rule="evenodd"
        />
      </svg>
    </button>
    {@render children()}
  </div>
</div>
