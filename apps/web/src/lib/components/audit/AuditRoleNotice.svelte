<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'

  // Story 69.4: the "requires the owner role" notice shown to a non-owner. `children` is the page's
  // `settings.audit.notice` injection point, rendered last inside the notice box.
  let { orgRole, children }: { orgRole: string; children?: Snippet } = $props()
</script>

<div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
  <p class="text-slate-600">This page requires the owner role.</p>
  <a href={resolve('/settings')} class="mt-2 inline-block text-sm text-indigo-600 underline">
    ← Back to Settings
  </a>
  {#if orgRole === 'admin'}
    <p class="mt-4 text-sm text-slate-600">
      You can still access
      <a href={resolve('/settings/audit/forwarding')} class="font-medium text-indigo-600 underline">
        Forwarding & Retention →
      </a>
    </p>
  {/if}{@render children?.()}
</div>
