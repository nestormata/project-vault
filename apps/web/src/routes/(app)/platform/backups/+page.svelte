<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformBreadcrumb from '$lib/components/platform/PlatformBreadcrumb.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import TypedConfirmInput from '$lib/components/forms/TypedConfirmInput.svelte'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    triggerBackup,
    validateBackup,
    restoreBackup,
    listBackups,
    type BackupListItem,
  } from '$lib/api/platform.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  let backups = $state<BackupListItem[]>(data.allowed ? data.backups : [])
  let pageError = $state<string | null>(data.allowed ? data.errorMessage : null)
  let triggerMessage = $state<string | null>(null)
  let triggerError = $state<string | null>(null)

  let validateResults = $state<Record<string, unknown>>({})
  let validateErrors = $state<Record<string, string>>({})

  let restoreExpandedFilename = $state<string | null>(null)
  let restoreTypedMatches = $state(false)
  let restoreReason = $state('')
  let restoreError = $state<string | null>(null)
  let restoreSuccess = $state<string | null>(null)
  let restorePending = $state(false)

  function statusLabel(status: 'running' | 'succeeded' | 'failed'): string {
    return { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' }[status]
  }

  async function refreshBackups() {
    try {
      const result = await listBackups(fetch)
      backups = result.items
    } catch {
      // ignore refresh errors; user can reload manually
    }
  }

  async function handleTrigger() {
    triggerMessage = null
    triggerError = null
    try {
      const result = await triggerBackup(fetch)
      triggerMessage = `Backup triggered (job ${result.jobId}). Refresh the list below to check progress.`
      await refreshBackups()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 409 && err.code === 'backup_already_running') {
          triggerError = err.message ?? 'A backup is already in progress.'
        } else if (err.status === 429) {
          triggerError = 'Too many trigger attempts — wait a moment and try again.'
        } else if (err.status === 503) {
          const body = err.body as { code?: string; status?: string; message?: string } | null
          if (body && 'status' in body && !('code' in body)) {
            triggerError =
              'The vault was sealed while you were on this page — unseal it to continue.'
          } else {
            triggerError = body?.message ?? 'Backup is not configured on this instance.'
          }
        } else {
          triggerError = err.message ?? 'Failed to trigger backup.'
        }
      } else {
        triggerError = 'Failed to trigger backup.'
      }
    }
  }

  async function handleValidate(filename: string) {
    validateErrors = { ...validateErrors, [filename]: '' }
    try {
      const result = await validateBackup(fetch, filename)
      validateResults = { ...validateResults, [filename]: result }
      await refreshBackups()
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? (err.message ?? 'Validation failed') : 'Validation failed'
      validateErrors = { ...validateErrors, [filename]: msg }
    }
  }

  function openRestore(filename: string) {
    restoreExpandedFilename = filename
    restoreTypedMatches = false
    restoreReason = ''
    restoreError = null
    restoreSuccess = null
  }

  function closeRestore() {
    restoreExpandedFilename = null
    restoreTypedMatches = false
    restoreReason = ''
    restoreError = null
  }

  async function handleRestore() {
    if (!restoreExpandedFilename) return
    restorePending = true
    restoreError = null
    restoreSuccess = null
    try {
      await restoreBackup(fetch, restoreExpandedFilename, {
        confirmRestore: true,
        reason: restoreReason,
      })
      restoreSuccess = restoreExpandedFilename
      restoreExpandedFilename = null
      await refreshBackups()
    } catch (err) {
      if (err instanceof ApiClientError) {
        const body = err.body as { code?: string; status?: string; message?: string } | null
        if (err.status === 503 && body && 'status' in body && !('code' in body)) {
          restoreError = 'The vault was sealed while you were on this page — unseal it to continue.'
        } else if (err.status === 401 && body?.code === 'backup_decrypt_failed') {
          restoreError = 'Backup could not be decrypted with the current master key.'
        } else if (err.status === 422 && body?.code === 'backup_checksum_mismatch') {
          restoreError =
            'Stored checksum does not match the backup file — refusing to restore a potentially corrupted or tampered backup.'
        } else if (err.status === 404) {
          restoreError = 'No backup found with that filename.'
          await refreshBackups()
        } else if (err.status === 409) {
          const code = body?.code
          if (code === 'restore_in_progress') {
            restoreError =
              'Another restore is already in progress. Wait for it to complete before retrying.'
          } else if (code === 'backup_in_progress') {
            restoreError =
              'A backup is currently running. Wait for it to complete before restoring.'
          } else {
            restoreError = err.message ?? 'Conflict.'
          }
        } else if (err.status === 400 && body?.code === 'confirmation_required') {
          restoreError =
            'Restore is destructive. confirmRestore: true and a reason are both required.'
        } else if (err.status === 400 && body?.code === 'invalid_filename') {
          restoreError = body?.message ?? 'Not a well-formed backup filename.'
        } else if (err.status === 500) {
          restoreError = 'Restore failed unexpectedly. See server logs for details.'
        } else {
          restoreError = err.message ?? 'Restore failed.'
        }
      } else {
        restoreError = 'Restore failed.'
      }
    } finally {
      restorePending = false
    }
  }

  const restoreEnabled = $derived(
    restoreExpandedFilename !== null && restoreTypedMatches && restoreReason.trim().length > 0
  )

  function getValidateResult(filename: string) {
    return validateResults[filename] as
      | {
          valid: boolean
          assetsPresent: {
            credentials: boolean
            projects: boolean
            users: boolean
            auditEvents: boolean
            dataErasureRequests: boolean
          }
          checksum: 'match' | 'mismatch'
        }
      | undefined
  }
</script>

<svelte:head>
  <title>Backups | Platform Admin | Project Vault</title>
</svelte:head>

<PlatformBreadcrumb
  allowed={data.allowed}
  trail={[{ label: 'Platform Admin', href: '/platform' }, { label: 'Backups' }]}
>
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">Backups</h1>
      <p class="mt-1 text-gray-500">Trigger, validate, and restore encrypted backups.</p>
    </div>
    <ConfirmDeleteButton
      label="Trigger backup now"
      confirmLabel="Confirm trigger?"
      pendingLabel="Triggering…"
      onConfirm={handleTrigger}
    />
  </div>

  {#if triggerMessage}
    <p
      class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
      role="status"
    >
      {triggerMessage}
    </p>
  {/if}
  {#if triggerError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {triggerError}
    </p>
  {/if}

  {#if restoreSuccess}
    <div
      class="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-4 text-sm text-green-900"
      role="status"
    >
      <p class="font-semibold">Restore complete.</p>
      <p class="mt-1">
        The vault has been automatically sealed and requires manual unseal to resume operation.
        <a href={resolve('/vault')} class="ml-1 underline hover:text-green-700">Unseal vault →</a>
      </p>
    </div>
  {/if}

  {#if pageError}
    <p
      class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {pageError}
    </p>
  {/if}

  <div class="mt-6">
    {#if backups.length === 0 && !pageError}
      <p class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500">
        No backups yet.
      </p>
    {:else}
      <DataTable
        columns={['Filename', 'Started', 'Status', 'Size', 'Verified', 'Key Version', 'Actions']}
      >
        {#each backups as backup (backup.filename)}
          <tr class="border-b border-slate-100 last:border-b-0">
            <td class="px-4 py-3 font-mono text-xs text-slate-800">{backup.filename}</td>
            <td class="px-4 py-3 text-sm text-slate-600"
              >{new Date(backup.timestamp).toLocaleString()}</td
            >
            <td class="px-4 py-3 text-sm">
              {#if backup.status === 'failed'}
                <span class="font-semibold text-red-700" title={backup.errorMessage ?? ''}>
                  Failed{backup.errorMessage ? ` — ${backup.errorMessage}` : ''}
                </span>
              {:else if backup.status === 'running'}
                <span class="text-amber-700">Running…</span>
              {:else}
                <span class="text-green-700">{statusLabel(backup.status)}</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-sm text-slate-600">{formatBytes(backup.sizeBytes)}</td>
            <td class="px-4 py-3 text-sm">
              {#if backup.verified === 'valid'}
                <span class="text-green-700">Valid ✓</span>
              {:else if backup.verified === 'invalid'}
                <span class="text-red-700">Invalid ✗</span>
              {:else}
                <span class="text-slate-500">Unverified</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-sm text-slate-600">{backup.keyVersion ?? '—'}</td>
            <td class="px-4 py-3 text-sm">
              <div class="flex gap-2">
                {#if backup.status !== 'running'}
                  <button
                    type="button"
                    class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                    onclick={() => void handleValidate(backup.filename)}
                  >
                    Validate
                  </button>
                  <button
                    type="button"
                    class="rounded border border-amber-300 px-2 py-1 text-xs text-amber-700 hover:bg-amber-50"
                    onclick={() => openRestore(backup.filename)}
                  >
                    Restore
                  </button>
                {/if}
              </div>
            </td>
          </tr>

          {#if validateResults[backup.filename] !== undefined}
            {@const vr = getValidateResult(backup.filename)}
            {#if vr}
              <tr class="bg-slate-50 border-b border-slate-100">
                <td colspan="7" class="px-4 py-3 text-sm">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="font-semibold">
                      {vr.valid ? '✓ Valid' : '✗ Invalid'}
                    </span>
                    {#if vr.checksum === 'mismatch'}
                      <span
                        class="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
                      >
                        ⚠ Checksum mismatch — this backup file may be corrupted or tampered with.
                      </span>
                    {/if}
                  </div>
                  <ul class="space-y-1 text-xs text-slate-600">
                    <li>Checksum: {vr.checksum === 'match' ? '✓ Match' : '✗ Mismatch'}</li>
                    <li>Credentials: {vr.assetsPresent.credentials ? '✓' : '✗ Missing'}</li>
                    <li>Projects: {vr.assetsPresent.projects ? '✓' : '✗ Missing'}</li>
                    <li>Users: {vr.assetsPresent.users ? '✓' : '✗ Missing'}</li>
                    <li>Audit events: {vr.assetsPresent.auditEvents ? '✓' : '✗ Missing'}</li>
                    <li>
                      Data erasure requests: {vr.assetsPresent.dataErasureRequests
                        ? '✓'
                        : '✗ Missing'}
                    </li>
                  </ul>
                </td>
              </tr>
            {/if}
          {/if}
          {#if validateErrors[backup.filename]}
            <tr class="bg-red-50 border-b border-slate-100">
              <td colspan="7" class="px-4 py-2 text-sm text-red-700">
                {validateErrors[backup.filename]}
              </td>
            </tr>
          {/if}

          {#if restoreExpandedFilename === backup.filename}
            <tr class="bg-amber-50 border-b border-slate-100">
              <td colspan="7" class="px-4 py-4">
                <div class="space-y-3">
                  <p class="text-sm font-semibold text-amber-900">
                    ⚠ Restore is destructive and irreversible. Type the exact filename to confirm.
                  </p>
                  <TypedConfirmInput
                    expectedValue={backup.filename}
                    onMatchChange={(matches) => {
                      restoreTypedMatches = matches
                    }}
                    label="Type the exact filename to confirm"
                    inputId="restore-typed-confirm"
                  />
                  <label class="block text-sm text-slate-700">
                    Reason for restore (required)
                    <textarea
                      class="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      rows="2"
                      bind:value={restoreReason}
                      placeholder="Enter reason for restore"></textarea>
                  </label>
                  {#if restoreError}
                    <p class="text-sm text-red-700" role="alert">{restoreError}</p>
                  {/if}
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!restoreEnabled || restorePending}
                      onclick={() => void handleRestore()}
                    >
                      {restorePending ? 'Restoring…' : 'Restore'}
                    </button>
                    <button
                      type="button"
                      class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
                      onclick={closeRestore}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </DataTable>
    {/if}
  </div>
</PlatformBreadcrumb>
