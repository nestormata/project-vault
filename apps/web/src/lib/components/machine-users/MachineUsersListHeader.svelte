<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import NavLink from '$lib/navigation/NavLink.svelte'

  let {
    canManage,
    projectId,
    children,
  }: { canManage: boolean; projectId: string; children?: Snippet } = $props()
</script>

<div
  class="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
>
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Machine users</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">CI/CD service identities</h1>
    <p class="mt-2 text-slate-600">Manage machine users and their API keys for this project.</p>
    <p class="mt-2 text-slate-600">
      Machine users provide non-interactive, CI/CD-scoped secret access — issue an API key here,
      then exchange it for a short-lived token to fetch secret values from your pipeline. See the
      <a
        href="https://github.com/nestormata/project-vault/blob/main/docs/machine-users.md"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-slate-700 underline"
      >
        machine users runbook
      </a>
      for the full flow, error cases, and a working curl example.
    </p>
    <NavLink
      surface="back"
      node="back.project.machine-users"
      class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
      {projectId}
    />
  </div>
  {#if canManage}
    <a
      class="rounded-xl bg-slate-950 px-4 py-3 text-center font-semibold text-white"
      href={resolve(`/projects/${projectId}/machine-users/new`)}
    >
      Create machine user
    </a>
  {/if}
</div>
{@render children?.()}
