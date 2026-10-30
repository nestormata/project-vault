<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import { PROJECT_DELETE_GRACE_DAYS } from '@project-vault/shared'

  // Story 72-9: the heading of the deleted projects page.
  let { children }: { children?: Snippet } = $props()
</script>

<div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</p>
  <h1 class="mt-2 text-3xl font-bold text-slate-950">Deleted projects</h1>
  <p class="mt-2 text-slate-600">
    A deleted project can be restored for {PROJECT_DELETE_GRACE_DAYS} days, then it is erased for good.
    <a class="font-medium text-slate-800 underline" href={resolve('/projects')}>Back to projects</a>
  </p>
  {@render children?.()}
</div>
