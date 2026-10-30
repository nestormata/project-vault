<script lang="ts">
  import type { Snippet } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { deleteProject } from '$lib/api/projects.js'
  import Button from '$lib/components/ui/Button.svelte'
  import { requestConfirm } from '$lib/state/confirm.svelte.js'
  import { deleteErrorOf } from './project-settings-logic.js'

  // Story 72-9: delete with a grace period. The user types the project name to confirm.
  let {
    project,
    graceDays,
    children,
  }: { project: { id: string; name: string }; graceDays: number; children?: Snippet } = $props()

  let deleting = $state(false)
  let errorMessage = $state<string | null>(null)

  async function onDelete(): Promise<void> {
    if (deleting) return
    const confirmed = await requestConfirm({
      title: 'Delete project?',
      message:
        `Delete "${project.name}"? It is hidden right away and its shares are revoked. ` +
        `You can restore it for ${graceDays} days; after that it is erased for good.`,
      confirmLabel: 'Delete project',
      variant: 'danger',
      typedValue: project.name,
      typedLabel: 'Type the project name to confirm',
    })
    if (!confirmed) return
    deleting = true
    errorMessage = null
    try {
      await deleteProject(fetch, project.id)
    } catch (error) {
      errorMessage = deleteErrorOf(error)
      deleting = false
      return
    }
    await goto(resolve('/projects/deleted'))
  }
</script>

{@render children?.()}
<div class="space-y-3 rounded-3xl border border-red-200 bg-white p-6 shadow-sm">
  <h2 class="text-xl font-semibold text-red-900">Delete project</h2>
  <p class="text-slate-700">
    The project disappears from every list and its shares are revoked. The project owner or an
    organization owner can restore it for {graceDays} days. After that its secrets, history and settings
    are erased permanently; the audit log keeps the record.
  </p>
  {#if errorMessage}
    <p class="text-sm text-red-700" role="alert">{errorMessage}</p>
  {/if}
  <Button variant="danger" disabled={deleting} onclick={() => void onDelete()}>
    {deleting ? 'Deleting...' : 'Delete project'}
  </Button>
</div>
