<!--
  Story 72.6: the badge or status of a nav node. Text in a chip when the node has a badge (the tone
  follows `status`); with only a status, a small dot plus a screen-reader word, so the tone is never
  conveyed by colour alone. Renders nothing when the node has neither.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import type { NavNode, NavStatus } from './types.js'

  let { node }: { node: Pick<NavNode, 'badge' | 'status'> } = $props()

  const TONES: Record<NavStatus, string> = {
    info: 'bg-sky-100 text-sky-900',
    success: 'bg-emerald-100 text-emerald-900',
    warning: 'bg-amber-100 text-amber-900',
    danger: 'bg-red-100 text-red-900',
  }
  const DOTS: Record<NavStatus, string> = {
    info: 'bg-sky-600',
    success: 'bg-emerald-600',
    warning: 'bg-amber-600',
    danger: 'bg-red-600',
  }
  const WORDS: Record<NavStatus, () => string> = {
    info: () => m.nav_status_info(),
    success: () => m.nav_status_success(),
    warning: () => m.nav_status_warning(),
    danger: () => m.nav_status_danger(),
  }

  const tone = $derived(
    node.status === undefined ? 'bg-slate-100 text-slate-800' : TONES[node.status]
  )
  const dot = $derived(node.status === undefined ? '' : DOTS[node.status])
  const word = $derived(node.status === undefined ? '' : WORDS[node.status]())
</script>

{#if node.badge !== undefined}
  <span
    class={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}
    data-nav-badge
    data-status={node.status}
  >
    {node.badge}
  </span>{#if node.status !== undefined}<span class="sr-only">{`, ${word}`}</span>{/if}
{:else if node.status !== undefined}
  <span
    class={`inline-block h-2 w-2 rounded-full ${dot}`}
    data-nav-status={node.status}
    aria-hidden="true"
  ></span><span class="sr-only">{`, ${word}`}</span>
{/if}
