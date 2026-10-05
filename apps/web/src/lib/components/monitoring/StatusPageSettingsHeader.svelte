<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project settings</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Public status page</h1>
  <p class="mt-2 text-slate-600">
    Share a read-only status page with stakeholders who don't have a Project Vault account. The
    services shown here are your monitored HTTP endpoints — a separate list from any billing or
    hosting "services" you've recorded elsewhere for this project.
  </p>
</div>
{@render children?.()}
