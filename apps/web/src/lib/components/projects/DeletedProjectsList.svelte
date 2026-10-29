<script lang="ts">
  import type { Snippet } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { ApiClientError } from '$lib/api/client.js'
  import { restoreProject } from '$lib/api/projects.js'
  import { formatDate } from '$lib/datetime.js'
  import Button from '$lib/components/ui/Button.svelte'
  import type { DeletedProject } from '@project-vault/shared'

  // Story 72-9: the deleted projects the caller may restore, each with its erase date.
  let { projects, children }: { projects: DeletedProject[]; children?: Snippet } = $props()

  let busyId = $state<string | null>(null)
  let message = $state<string | null>(null)
  let failed = $state(false)

  async function onRestore(project: DeletedProject): Promise<void> {
    if (busyId) return
    busyId = project.id
    message = null
    try {
      await restoreProject(fetch, project.id)
      failed = false
      message = `"${project.name}" is restored and archived. Unarchive it from the project list.`
      await invalidateAll()
    } catch (error) {
      failed = true
      message =
        error instanceof ApiClientError && error.status === 403
          ? 'Only the project owner or an organization owner can restore this project.'
          : 'The project could not be restored.'
    } finally {
      busyId = null
    }
  }
</script>

{@render children?.()}
<div class="space-y-3">
  {#if message}
    <p class={failed ? 'text-sm text-red-700' : 'text-sm text-green-800'} role="status">
      {message}
    </p>
  {/if}
  {#if projects.length === 0}
    <p class="rounded-3xl border border-slate-200 bg-white p-6 text-slate-700 shadow-sm">
      There are no deleted projects to restore.
    </p>
  {:else}
    <ul class="space-y-3">
      {#each projects as project (project.id)}
        <li
          class="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p class="text-lg font-semibold text-slate-950">{project.name}</p>
            <p class="text-sm text-slate-600">
              Deleted {formatDate(project.deletedAt)} · erased for good on {formatDate(
                project.purgeAfter
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={busyId === project.id}
            onclick={() => void onRestore(project)}
          >
            Restore
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
