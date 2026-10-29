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
  import DetailsMenu from './DetailsMenu.svelte'

  let { items, itemClass }: { items: NavNode[]; itemClass: string } = $props()
</script>

{#snippet label()}{m.shell_account_menu()} <span aria-hidden="true">▾</span>{/snippet}
<DetailsMenu
  testid="account-menu"
  summary={label}
  summaryClass="cursor-pointer list-none rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-800"
  panelClass="mt-1 flex min-w-48 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-lg md:absolute md:right-0 md:z-10"
>
  {#each items as item (item.id)}
    <NavNodeEntry node={item} class={itemClass} />
  {/each}
</DetailsMenu>
