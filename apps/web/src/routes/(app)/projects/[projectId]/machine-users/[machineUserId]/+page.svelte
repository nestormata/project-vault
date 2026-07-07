<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import {
    deactivateMachineUser,
    emergencyRevokeApiKey,
    issueApiKey,
    revokeApiKey,
    rotateApiKey,
  } from '$lib/api/machine-users.js'
  import { ApiClientError } from '$lib/api/client.js'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import { canManageMachineUsers } from '$lib/machine-users/permissions.js'

  let { data } = $props()

  const canManage = $derived(canManageMachineUsers(data.orgRole))
  const isDeactivated = $derived(data.machineUser?.deactivatedAt != null)

  // AC-2/AC-3: the plaintext key is shown exactly once — from issue, rotate (the new key), or
  // emergency-revoke (the new key) — never re-fetchable afterwards. Ephemeral, component-local
  // state that is never persisted to (or re-derived from) the server load data.
  let revealedKey = $state<{ label: string; value: string } | null>(null)

  let issueName = $state('')
  let issuing = $state(false)
  let issueError = $state<string | null>(null)

  let overlapByKey = $state<Record<string, number>>({})
  let actionError = $state<string | null>(null)
  let deactivateError = $state<string | null>(null)
  let deactivating = $state(false)

  function overlapFor(keyId: string): number {
    return overlapByKey[keyId] ?? 240
  }

  function formatDate(value: string | null): string {
    if (!value) return '—'
    return new Date(value).toLocaleString()
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard may be unavailable in some contexts.
    }
  }

  async function onIssueKey() {
    if (issuing || !canManage) return
    if (!issueName.trim()) {
      issueError = 'Name is required.'
      return
    }
    issuing = true
    issueError = null
    try {
      const created = await issueApiKey(fetch, data.machineUserId, { name: issueName.trim() })
      revealedKey = { label: created.name, value: created.key }
      issueName = ''
      await invalidateAll()
    } catch (error) {
      issueError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to issue API key.')
          : 'Failed to issue API key.'
    } finally {
      issuing = false
    }
  }

  async function onRevoke(keyId: string) {
    actionError = null
    try {
      await revokeApiKey(fetch, data.machineUserId, keyId)
      await invalidateAll()
    } catch (error) {
      actionError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to revoke key.')
          : 'Failed to revoke key.'
    }
  }

  async function onRotate(keyId: string, keyName: string) {
    actionError = null
    try {
      const result = await rotateApiKey(fetch, data.machineUserId, keyId, overlapFor(keyId))
      revealedKey = { label: `${keyName} (rotated)`, value: result.key }
      await invalidateAll()
    } catch (error) {
      actionError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to rotate key.')
          : 'Failed to rotate key.'
    }
  }

  async function onEmergencyRevoke(keyId: string, keyName: string) {
    actionError = null
    try {
      const result = await emergencyRevokeApiKey(fetch, data.machineUserId, keyId)
      revealedKey = { label: `${keyName} (emergency-revoked, new key)`, value: result.newKey }
      await invalidateAll()
    } catch (error) {
      actionError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to emergency-revoke key.')
          : 'Failed to emergency-revoke key.'
    }
  }

  async function onDeactivate() {
    if (deactivating) return
    deactivating = true
    deactivateError = null
    try {
      await deactivateMachineUser(fetch, data.machineUserId)
      await invalidateAll()
    } catch (error) {
      deactivateError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to deactivate machine user.')
          : 'Failed to deactivate machine user.'
    } finally {
      deactivating = false
    }
  }
</script>

<svelte:head>
  <title>{data.machineUser?.name ?? 'Machine user'} | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  {#if data.notFound || !data.machineUser}
    <PageAlertBanner
      title="Machine user not found"
      message="This machine user does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/machine-users`}
      backLabel="Back to machine users"
    />
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div class="flex flex-wrap items-center gap-3">
        <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Machine user</p>
        {#if isDeactivated}
          <span class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700">
            Deactivated
          </span>
        {:else}
          <span
            class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
          >
            Active
          </span>
        {/if}
      </div>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.machineUser.name}</h1>
      {#if data.machineUser.description}
        <p class="mt-2 text-slate-600">{data.machineUser.description}</p>
      {/if}
      <dl class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Role</dt>
          <dd class="font-medium text-slate-950">{data.machineUser.role}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Created</dt>
          <dd class="font-medium text-slate-950">{formatDate(data.machineUser.createdAt)}</dd>
        </div>
      </dl>

      <div class="mt-5 rounded-2xl bg-slate-50 p-4">
        <p class="text-sm font-semibold text-slate-900">Scope boundary</p>
        <div class="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <p class="text-xs font-semibold uppercase text-slate-500">Can access</p>
            <ul class="mt-1 list-inside list-disc text-sm text-slate-700">
              {#each data.machineUser.scopeBoundary.canAccess as item (item)}
                <li>{item}</li>
              {/each}
            </ul>
          </div>
          <div>
            <p class="text-xs font-semibold uppercase text-slate-500">Cannot access</p>
            <ul class="mt-1 list-inside list-disc text-sm text-slate-700">
              {#each data.machineUser.scopeBoundary.cannotAccess as item (item)}
                <li>{item}</li>
              {/each}
            </ul>
          </div>
        </div>
      </div>

      {#if canManage && !isDeactivated}
        <div class="mt-5">
          {#if deactivateError}
            <p class="mb-2 text-sm text-red-700" role="alert">{deactivateError}</p>
          {/if}
          <ConfirmDeleteButton
            label="Deactivate"
            confirmLabel="Confirm deactivate?"
            pendingLabel="Deactivating…"
            onConfirm={onDeactivate}
          />
        </div>
      {/if}
    </div>

    {#if revealedKey}
      <section class="rounded-2xl border border-amber-300 bg-amber-50 p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">
          New API key — {revealedKey.label}
        </h2>
        <p class="mt-1 text-sm font-semibold text-red-700">
          This value will never be shown again. Copy it now.
        </p>
        <pre
          class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{revealedKey.value}</pre>
        <div class="mt-3 flex gap-3">
          <button
            class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
            type="button"
            onclick={() => revealedKey && void copyValue(revealedKey.value)}
          >
            Copy
          </button>
          <button
            class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
            type="button"
            onclick={() => {
              revealedKey = null
            }}
          >
            Hide
          </button>
        </div>
      </section>
    {/if}

    {#if canManage && !isDeactivated}
      <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-950">Issue a new API key</h2>
        <form
          class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onsubmit={(event) => {
            event.preventDefault()
            void onIssueKey()
          }}
        >
          <div class="flex-1 space-y-1">
            <label class="block text-sm font-medium text-slate-800" for="issue-key-name">
              Key name
            </label>
            <input
              id="issue-key-name"
              class="w-full rounded-xl border border-slate-300 px-3 py-2"
              type="text"
              bind:value={issueName}
              required
            />
          </div>
          <button
            class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-60"
            type="submit"
            disabled={issuing}
          >
            {issuing ? 'Issuing…' : 'Issue key'}
          </button>
        </form>
        {#if issueError}
          <p class="mt-2 text-sm text-red-700" role="alert">{issueError}</p>
        {/if}
      </section>
    {/if}

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">API keys</h2>
      {#if actionError}
        <p class="mt-2 text-sm text-red-700" role="alert">{actionError}</p>
      {/if}
      {#if data.apiKeys.items.length === 0}
        <p class="mt-3 text-sm text-slate-600">No API keys have been issued yet.</p>
      {:else}
        <ul class="mt-4 space-y-3">
          {#each data.apiKeys.items as key (key.id)}
            <li class="rounded-xl border border-slate-200 p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="font-medium text-slate-950">{key.name}</p>
                  <p class="text-sm text-slate-600">
                    Expires {formatDate(key.expiresAt)} · Last used {formatDate(key.lastUsedAt)}
                  </p>
                </div>
                {#if key.isRevoked}
                  <span
                    class="rounded-full bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                  >
                    Revoked
                  </span>
                {:else}
                  <span
                    class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
                  >
                    Active
                  </span>
                {/if}
              </div>

              {#if canManage && !key.isRevoked}
                <div class="mt-3 flex flex-wrap items-center gap-3">
                  <label class="flex items-center gap-2 text-sm text-slate-700">
                    Overlap (min)
                    <input
                      class="w-20 rounded-lg border border-slate-300 px-2 py-1"
                      type="number"
                      min="1"
                      max="1440"
                      value={overlapFor(key.id)}
                      oninput={(event) => {
                        overlapByKey = {
                          ...overlapByKey,
                          [key.id]: Number((event.target as HTMLInputElement).value) || 240,
                        }
                      }}
                    />
                  </label>
                  <ConfirmDeleteButton
                    label="Rotate"
                    confirmLabel="Confirm rotate?"
                    pendingLabel="Rotating…"
                    onConfirm={() => onRotate(key.id, key.name)}
                  />
                  <ConfirmDeleteButton
                    label="Emergency revoke"
                    confirmLabel="Confirm emergency revoke?"
                    pendingLabel="Revoking…"
                    onConfirm={() => onEmergencyRevoke(key.id, key.name)}
                  />
                  <ConfirmDeleteButton
                    label="Revoke"
                    confirmLabel="Confirm revoke?"
                    pendingLabel="Revoking…"
                    onConfirm={() => onRevoke(key.id)}
                  />
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/machine-users`)}
    >
      Back to machine users
    </a>
  {/if}
</section>
