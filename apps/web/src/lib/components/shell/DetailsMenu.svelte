<!--
  Story 72.7: the disclosure menu the shell's menus share (the account menu, the bottom bar's and
  the project tabs' "More"). A native <details>/<summary> (works without script; keyboard: Tab
  focuses, Enter/Space toggles) whose close rules live in `details-menu.ts`: Escape closes it and
  returns focus to the trigger, and so do a click outside, tabbing out and choosing an entry.
  The caller owns the trigger's content and the look of the trigger and the panel.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { attachDetailsMenu } from './details-menu.js'

  let {
    summary,
    children,
    summaryClass,
    panelClass,
    testid,
    current,
  }: {
    summary: Snippet
    children: Snippet
    summaryClass: string
    panelClass: string
    testid?: string
    /** Sets `data-current` on the trigger (an entry inside the panel is the current page). */
    current?: boolean
  } = $props()

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
    return attachDetailsMenu(root, summaryEl, close)
  })
</script>

<details bind:open bind:this={rootEl} class="relative" data-testid={testid}>
  <summary bind:this={summaryEl} class={summaryClass} data-current={current ? 'true' : undefined}
    >{@render summary()}</summary
  >
  <div class={panelClass}>
    {@render children()}
  </div>
</details>
