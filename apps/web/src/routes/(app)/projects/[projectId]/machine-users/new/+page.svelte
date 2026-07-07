<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { createMachineUser } from '$lib/api/machine-users.js'
  import { ApiClientError } from '$lib/api/client.js'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'
  import type { MachineUserRole } from '@project-vault/shared'

  let { data } = $props()

  let name = $state('')
  let role = $state<MachineUserRole>('member')
  let description = $state('')
  let submitting = $state(false)
  let errorMessage = $state<string | null>(null)

  const canCreate = $derived(canManageMachineUsers(data.orgRole))

  async function submitForm() {
    if (submitting || !canCreate) return
    if (!name.trim()) {
      errorMessage = 'Name is required.'
      return
    }

    submitting = true
    errorMessage = null
    try {
      const created = await createMachineUser(fetch, data.projectId, {
        name: name.trim(),
        role,
        description: description.trim() ? description.trim() : null,
      })
      await goto(resolve(`/projects/${data.projectId}/machine-users/${created.id}`))
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

<svelte:head>
  <title>New machine user | Project Vault</title>
</svelte:head>

<section class="mx-auto max-w-2xl space-y-6">
  <div>
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Machine users</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Create machine user</h1>
  </div>

  {#if !canCreate}
    <AccessNotice
      title="Create not available"
      message="Creating machine users requires Admin access or higher. Ask your organization admin/owner."
      backHref={`/projects/${data.projectId}/machine-users`}
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
      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="machine-user-name">Name</label>
        <input
          id="machine-user-name"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          type="text"
          bind:value={name}
          autocomplete="off"
          required
        />
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="machine-user-role">Role</label>
        <select
          id="machine-user-role"
          class="w-full rounded-xl border border-slate-300 px-3 py-3"
          bind:value={role}
        >
          <option value="member">Member — can read/write project credentials</option>
          <option value="viewer">Viewer — read-only project credentials</option>
        </select>
      </div>

      <div class="space-y-2">
        <label class="block font-medium text-slate-900" for="machine-user-description">
          Description
        </label>
        <textarea
          id="machine-user-description"
          class="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-3"
          bind:value={description}></textarea>
      </div>

      {#if errorMessage}
        <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </p>
      {/if}

      <FormSubmitRow
        submitLabel="Create machine user"
        pendingLabel="Creating…"
        cancelHref={`/projects/${data.projectId}/machine-users`}
        {submitting}
      />
    </form>
  {/if}
</section>
