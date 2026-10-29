<!--
  Story 72.6 (P3a): the account dropdown. A native <details>/<summary> disclosure (works without
  script; keyboard: Tab focuses, Enter/Space toggles) whose panel lists the `account` surface's
  nodes: links, the Help external link and actions (Keyboard shortcuts, Sign out). Escape and a
  click outside close it; Escape returns focus to the trigger. Choosing an item closes the menu and
  puts focus on the trigger first, so a dialog the item opens returns focus to something visible.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import NavDisclosure from '$lib/navigation/NavDisclosure.svelte'
  import NavEntry from '$lib/navigation/NavEntry.svelte'
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
    function onPressed(event: KeyboardEvent) {
      if (event.code !== 'Escape') return
      event.stopPropagation()
      close(true)
    }
    function onClick(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Element)) return
      if (!root?.contains(target)) close(false)
      // A link or button inside the panel closes the menu; a disclosure's summary does not.
      else if (!summaryEl?.contains(target) && target.closest('a, button')) close(true)
    }
    root.addEventListener('keydown', onPressed)
    window.addEventListener('click', onClick)
    return () => {
      root.removeEventListener('keydown', onPressed)
      window.removeEventListener('click', onClick)
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
      {#if item.children.length > 0}
        <NavDisclosure node={item} class={itemClass} />
      {:else}
        <NavEntry node={item} class={itemClass} />
      {/if}
    {/each}
  </div>
</details>
