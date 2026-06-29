<script lang="ts">
  import { trapFocus } from './focus-trap.js'

  let {
    dialogRef = $bindable<HTMLElement | null>(null),
    labelledby,
    children,
  }: {
    dialogRef?: HTMLElement | null
    labelledby: string
    children: import('svelte').Snippet
  } = $props()

  $effect(() => {
    if (!dialogRef) return
    return trapFocus(dialogRef)
  })
</script>

<div
  bind:this={dialogRef}
  class="fixed inset-0 z-50 flex max-h-[100dvh] items-start justify-center overflow-y-auto bg-slate-950/70 p-4 sm:items-center"
  role="dialog"
  aria-modal="true"
  aria-labelledby={labelledby}
>
  <div class="my-auto w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl sm:p-8">
    {@render children()}
  </div>
</div>
