<script lang="ts">
  import type { Snippet } from 'svelte'
  import AuditForwardingForwarder from './AuditForwardingForwarder.svelte'
  import AuditForwardingRetention from './AuditForwardingRetention.svelte'

  // Story 69.10: the panel is the access gate plus its two cards; each card is a sub-region that owns
  // its own state (forwarding: type and both forms; retention: days and the keep-forever switch).
  let {
    allowed,
    data,
    children,
  }: {
    allowed: boolean
    /** The page's `__inject` map, forwarded to every sub-region's point. */
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()
</script>

{@render children?.()}
{#if !allowed}
  <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
    <p class="text-slate-600">This page requires the admin role or above.</p>
  </div>
{:else}
  <AuditForwardingForwarder {data} />
  <AuditForwardingRetention {data} />
{/if}
