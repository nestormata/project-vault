<script lang="ts">
  import type { Snippet } from 'svelte'

  // Story 69.2: the Archive / Unarchive control cluster (top right of the header card) as one
  // replaceable region. The busy flag, the error and the two handlers stay with the header card (the
  // error renders below the title row, so it cannot live in this cluster). `children` is the
  // region's injection point, rendered last, whatever the caller's role: PV hides nothing from CM.
  let {
    canArchive,
    archived,
    busy,
    onArchive,
    onUnarchive,
    children,
  }: {
    canArchive: boolean
    archived: boolean
    busy: boolean
    onArchive: () => void | Promise<void>
    onUnarchive: () => void | Promise<void>
    children?: Snippet
  } = $props()
</script>

{#if canArchive}
  {#if archived}
    <button
      type="button"
      class="cursor-pointer text-sm font-medium text-slate-700 underline hover:text-slate-950 focus-visible:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
      title="Unarchive this secret"
      disabled={busy}
      onclick={() => onUnarchive()}
    >
      Unarchive
    </button>
  {:else}
    <button
      type="button"
      class="cursor-pointer text-sm font-medium text-amber-700 underline hover:text-amber-900 focus-visible:text-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
      title="Archive this secret"
      disabled={busy}
      onclick={() => onArchive()}
    >
      Archive secret
    </button>
  {/if}
{/if}{@render children?.()}
