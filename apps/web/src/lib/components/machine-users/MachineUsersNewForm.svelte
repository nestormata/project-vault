<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/machine-users/new/$types.js'
  import type { Snippet } from 'svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createMachineUser } from '$lib/api/machine-users.js'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'
  import type { MachineUserRole } from '@project-vault/shared'
  import MachineUsersNewDescription from './MachineUsersNewDescription.svelte'
  import MachineUsersNewError from './MachineUsersNewError.svelte'
  import MachineUsersNewName from './MachineUsersNewName.svelte'
  import MachineUsersNewRole from './MachineUsersNewRole.svelte'
  import MachineUsersNewSubmit from './MachineUsersNewSubmit.svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  // Story 69.12: the form owns every typed value and the submit; each field group is a sub-region.
  // `pageData` is the page's load data, `data` is its `__inject` map.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  let name = $state('')
  let role = $state<MachineUserRole>('member')
  let description = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)
  const canCreate = $derived(canManageMachineUsers(pageData.orgRole))
  async function submitForm() {
    if (submitting || !canCreate) return
    if (!name.trim()) {
      errorMessage = 'Name is required.'
      return
    }

    submitting = true
    errorMessage = null
    try {
      const created = await createMachineUser(fetch, pageData.projectId, {
        name: name.trim(),
        role,
        description: description.trim() ? description.trim() : null,
      })
      await goto(resolve(`/projects/${pageData.projectId}/machine-users/${created.id}`))
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to create machine user.')
          : 'Failed to create machine user.'
    } finally {
      submitting = false
    }
  }
</script>

{@render children?.()}
{#if !canCreate}
  <AccessNotice
    title="Create not available"
    message="Creating machine users requires Admin access or higher. Ask your organization admin/owner."
    backHref={`/projects/${pageData.projectId}/machine-users`}
    backLabel="Back to machine users"
  />
{:else}
  <form
    class="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    onsubmit={(event) => {
      event.preventDefault()
      void submitForm()
    }}
  >
    <MachineUsersNewName bind:name {data} />

    <MachineUsersNewRole bind:role {data} />

    <MachineUsersNewDescription bind:description {data} />

    <MachineUsersNewError {errorMessage} {data} />

    <MachineUsersNewSubmit projectId={pageData.projectId} {submitting} {data} />
  </form>
{/if}
