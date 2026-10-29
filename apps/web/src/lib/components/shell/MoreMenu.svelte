<!--
  Story 72.7 (P3b): the "More" overflow menu of the bottom bar and of the project tabs: a
  `DetailsMenu` whose panel holds the overflowed entries. The trigger is marked current while any
  overflowed entry is, so the active page is never hidden behind a plain "More".
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import DetailsMenu from './DetailsMenu.svelte'

  let {
    current = false,
    placement = 'down',
    summaryClass,
    testid,
    children,
  }: {
    current?: boolean
    /** Where the panel opens: `up` for the bottom bar, `down` for the project tabs. */
    placement?: 'up' | 'down'
    summaryClass: string
    testid?: string
    children: Snippet
  } = $props()
</script>

{#snippet label()}{m.shell_more()}{/snippet}
<DetailsMenu
  {testid}
  {current}
  summary={label}
  summaryClass={`cursor-pointer list-none ${summaryClass}`}
  panelClass={`absolute z-20 flex min-w-48 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-lg ${placement === 'up' ? 'bottom-full right-0 mb-2' : 'right-0 mt-1'}`}
  {children}
/>
