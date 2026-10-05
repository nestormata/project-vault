<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/machine-users/new/$types.js'
  import type { Snippet } from 'svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { resolve } from '$app/paths'
  import { goto } from '$app/navigation'
  import { createMachineUser } from '$lib/api/machine-users.js'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'
  import type { MachineUserRole } from '@project-vault/shared'
  import FormSubmitRow from '$lib/components/forms/FormSubmitRow.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import AccessNotice from '$lib/components/credentials/AccessNotice.svelte'

  let { data, children }: { data: PageData; children?: Snippet } = $props()

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

{@render children?.()}
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
        aria-describedby="machine-user-name-help"
      />
      <FormHelpText id="machine-user-name-help" kind="text" />
    </div>

    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="machine-user-role">Role</label>
      <select
        id="machine-user-role"
        class="w-full rounded-xl border border-slate-300 px-3 py-3"
        aria-describedby="machine-user-role-help"
        bind:value={role}
      >
        <option value="member">Member — can read/write project secrets</option>
        <option value="viewer">Viewer — read-only project secrets</option>
      </select>
      <FormHelpText id="machine-user-role-help" text={m.form_help_machine_user_role()} />
    </div>

    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="machine-user-description">
        Description
      </label>
      <textarea
        id="machine-user-description"
        class="min-h-24 w-full rounded-xl border border-slate-300 px-3 py-3"
        bind:value={description}
        aria-describedby="machine-user-description-help"></textarea>
      <FormHelpText id="machine-user-description-help" kind="text" />
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
