<!--
  Story 72.6 (P3a): the account dropdown. A native <details>/<summary> disclosure (works without
  script; keyboard: Tab focuses, Enter/Space toggles) whose panel lists the `account` surface's
  nodes: links, the Help external link and actions (Keyboard shortcuts, Sign out). Escape, a click
  outside and tabbing out close it; Escape returns focus to the trigger. Choosing an item closes
  the menu and puts focus on the trigger BEFORE the item's own handler runs (capture phase), so a
  dialog the item opens returns focus to a visible element.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import NavNodeEntry from '$lib/navigation/NavNodeEntry.svelte'
  import type { NavNode } from '$lib/navigation/types.js'

  let { items, itemClass }: { items: NavNode[]; itemClass: string } = $props()

  let open = $state(false)
  let summaryEl = $state<HTMLElement | null>(null)
  let rootEl = $state<HTMLElement | null>(null)

  function close(returnFocus: boolean) {
    open = false
    if (returnFocus) summaryEl?.focus()
  }

  $effect(() => {
    const root = rootEl
    if (!open || !root) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close(true)
    }
    function onInsideClick(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Element) || summaryEl?.contains(target)) return
      // A link or button inside the panel closes the menu; a disclosure's summary does not.
      if (target.closest('a, button')) close(true)
    }
    function onOutsideClick(event: MouseEvent) {
      if (event.target instanceof Node && !root?.contains(event.target)) close(false)
    }
    // Tabbing out of the menu closes it and leaves focus where the user put it.
    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget
      if (next instanceof Node && !root?.contains(next)) close(false)
    }
    root.addEventListener('keydown', onKeyDown)
    root.addEventListener('click', onInsideClick, true)
    root.addEventListener('focusout', onFocusOut)
    window.addEventListener('click', onOutsideClick)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      root.removeEventListener('click', onInsideClick, true)
      root.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('click', onOutsideClick)
    }
  })
</script>

<details bind:open bind:this={rootEl} class="relative" data-testid="account-menu">
  <summary
    bind:this={summaryEl}
    class="cursor-pointer list-none rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800"
    >{m.shell_account_menu()} <span aria-hidden="true">▾</span></summary
  >
  <div
    class="mt-1 flex min-w-48 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-lg md:absolute md:right-0 md:z-10"
  >
    {#each items as item (item.id)}
      <NavNodeEntry node={item} class={itemClass} />
    {/each}
  </div>
</details>
