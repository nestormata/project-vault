<!--
  @pv-stable: the props contract ({ open, id, title, description, dismissible, onclose, children,
  footer }) is final (Story 72.5). A modal dialog on the native `<dialog>` element: `showModal()`
  gives the focus trap (everything outside is inert), Escape (the `cancel` event) and the top layer;
  this component adds the accessible name (`aria-labelledby` the title), the description, the return
  of focus to the element that opened it, and the backdrop click.

  `id` is required and explicit (no generated ids, so SSR and hydration cannot disagree); the title
  is `<id>-title` and the description `<id>-description`. The `<dialog>` element is always rendered
  (it must exist to be opened), so callers render the whole component only while they need it.
  `onclose` fires once the dialog has closed, whatever the cause (Escape, backdrop, `open = false`).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    open = $bindable(false),
    id,
    title,
    description,
    dismissible = true,
    onclose,
    children,
    footer,
  }: {
    open?: boolean
    id: string
    title: string
    description?: string
    /** Escape and a backdrop click close the dialog. Turn off for a flow that must be answered. */
    dismissible?: boolean
    onclose?: () => void
    children?: Snippet
    footer?: Snippet
  } = $props()

  let dialogEl = $state<HTMLDialogElement | null>(null)
  let returnTo: HTMLElement | null = null

  const titleId = $derived(`${id}-title`)
  const descriptionId = $derived(`${id}-description`)

  function focusInitial(el: HTMLDialogElement) {
    // `data-autofocus` marks the control a dialog wants first (the safe choice of a destructive
    // confirmation); without one the browser focuses the first focusable element itself.
    const marked = el.querySelector<HTMLElement>('[data-autofocus]')
    if (!marked) return
    const target = marked.matches('button, input, select, textarea, a[href]')
      ? marked
      : marked.querySelector<HTMLElement>('button, input, select, textarea, a[href]')
    target?.focus()
  }

  function show(el: HTMLDialogElement) {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (typeof el.showModal === 'function') el.showModal()
    else el.setAttribute('open', '')
    focusInitial(el)
  }

  function hide(el: HTMLDialogElement) {
    if (typeof el.close === 'function') el.close()
    else {
      // A browser without the dialog API: close by hand and raise the same event.
      el.removeAttribute('open')
      el.dispatchEvent(new Event('close'))
    }
  }

  $effect(() => {
    const el = dialogEl
    if (!el) return
    const isOpen = el.hasAttribute('open')
    if (open && !isOpen) show(el)
    else if (!open && isOpen) hide(el)
  })

  // Torn down while still open (the owner stopped rendering it): hand focus back all the same.
  $effect(() => () => {
    if (returnTo?.isConnected) returnTo.focus()
  })

  $effect(() => {
    const found = dialogEl
    if (!found) return
    const el: HTMLDialogElement = found
    function handleClose() {
      open = false
      // Browsers return focus on close; do it explicitly as well so it also holds when the opener
      // was re-rendered or the dialog was closed by script.
      if (returnTo?.isConnected) returnTo.focus()
      returnTo = null
      onclose?.()
    }
    function handleCancel(event: Event) {
      if (!dismissible) event.preventDefault()
    }
    function handleClick(event: MouseEvent) {
      // The backdrop is the dialog element itself (the panel inside fills it).
      if (dismissible && event.target === el) hide(el)
    }
    el.addEventListener('close', handleClose)
    el.addEventListener('cancel', handleCancel)
    el.addEventListener('click', handleClick)
    return () => {
      el.removeEventListener('close', handleClose)
      el.removeEventListener('cancel', handleCancel)
      el.removeEventListener('click', handleClick)
    }
  })
</script>

<dialog
  bind:this={dialogEl}
  {id}
  class="m-auto w-full max-w-lg rounded-2xl bg-white p-0 text-slate-950 shadow-xl backdrop:bg-slate-950/60"
  aria-labelledby={titleId}
  aria-describedby={description ? descriptionId : undefined}
>
  <div class="flex flex-col gap-4 p-6">
    <h2 id={titleId} class="text-lg font-semibold text-slate-950">{title}</h2>
    {#if description}
      <p id={descriptionId} class="text-sm text-slate-700">{description}</p>
    {/if}
    {@render children?.()}
    {#if footer}
      <div class="flex flex-wrap justify-end gap-3">
        {@render footer()}
      </div>
    {/if}
  </div>
</dialog>
