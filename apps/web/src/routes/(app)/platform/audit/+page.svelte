<script lang="ts">
  import { resolve } from '$app/paths'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import AuditDateRangeInputs from '$lib/components/audit/AuditDateRangeInputs.svelte'
  import AuditPaginationControls from '$lib/components/audit/AuditPaginationControls.svelte'
  import PlatformBreadcrumb from '$lib/components/platform/PlatformBreadcrumb.svelte'
  import { buildSearchSubmitHandler } from '$lib/audit/search-form.js'
  import { buildPageHref } from '$lib/audit/page-href.js'
  import { buildDateRangePart } from '$lib/audit/date-range.js'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    verifyPlatformAuditIntegrity,
    postMaintenanceMode,
    getMaintenanceModeStatus,
    type MaintenanceModeStatus,
    type PlatformAuditVerifyResult,
  } from '$lib/api/platform.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  let maintenanceStatus = $state<MaintenanceModeStatus | null>(
    data.allowed ? data.maintenanceStatus : null
  )
  let maintenanceStatusError = $state<string | null>(
    data.allowed ? data.maintenanceStatusError : null
  )

  let dateRangeError = $state<string | null>(null)
  const handleSearchSubmit = buildSearchSubmitHandler((err) => {
    dateRangeError = err
  })

  // Verify panel state
  let verifyFrom = $state('')
  let verifyTo = $state('')
  let verifyResult = $state<PlatformAuditVerifyResult | null>(null)
  let verifyError = $state<string | null>(null)
  let verifying = $state(false)

  // Maintenance mode state
  let activateReason = $state('')
  let maintenanceError = $state<string | null>(null)
  let maintenanceMfaError = $state<string | null>(null)

  const hasFilters = $derived(
    data.allowed && data.filters && Object.values(data.filters).some((v) => Boolean(v))
  )

  function filterSummary(filters: Record<string, string | undefined>): string {
    const parts: string[] = []
    if (filters.actionType) parts.push(`action = ${filters.actionType}`)
    if (filters.operatorId) parts.push(`operator = ${filters.operatorId}`)
    if (filters.targetOrgId) parts.push(`org = ${filters.targetOrgId}`)
    if (filters.targetUserId) parts.push(`user = ${filters.targetUserId}`)
    const datePart = buildDateRangePart(filters)
    if (datePart) parts.push(datePart)
    return parts.join(', ')
  }

  const pageHref = $derived(buildPageHref(data.allowed ? data.filters : undefined))

  async function handleVerify(e: SubmitEvent) {
    e.preventDefault()
    if (!verifyFrom || !verifyTo) return
    verifying = true
    verifyResult = null
    verifyError = null
    try {
      const result = await verifyPlatformAuditIntegrity(fetch, { from: verifyFrom, to: verifyTo })
      verifyResult = result
    } catch (err) {
      verifyError =
        err instanceof ApiClientError
          ? (err.message ?? 'Verification failed')
          : 'Verification failed'
    } finally {
      verifying = false
    }
  }

  async function refreshMaintenanceStatus() {
    try {
      const status = await getMaintenanceModeStatus(fetch)
      maintenanceStatus = status
      maintenanceStatusError = null
    } catch {
      maintenanceStatusError =
        'Maintenance mode status unavailable — action disabled until status can be confirmed'
    }
  }

  async function handleActivateMaintenance() {
    maintenanceError = null
    maintenanceMfaError = null
    try {
      await postMaintenanceMode(fetch, { action: 'activate', reason: activateReason.trim() })
      activateReason = ''
      await refreshMaintenanceStatus()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          maintenanceMfaError = err.message ?? 'MFA required'
        } else if (err.status === 409) {
          maintenanceError = err.message ?? 'Maintenance mode is already active.'
          await refreshMaintenanceStatus()
        } else {
          maintenanceError = err.message ?? 'Failed to activate maintenance mode'
        }
      } else {
        maintenanceError = 'Failed to activate maintenance mode'
      }
    }
  }

  async function handleDeactivateMaintenance() {
    maintenanceError = null
    maintenanceMfaError = null
    try {
      await postMaintenanceMode(fetch, { action: 'deactivate' })
      await refreshMaintenanceStatus()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          maintenanceMfaError = err.message ?? 'MFA required'
        } else if (err.status === 503) {
          maintenanceError =
            err.message ??
            'Cannot deactivate maintenance mode: platform audit log is still unavailable'
          await refreshMaintenanceStatus()
        } else {
          maintenanceError = err.message ?? 'Failed to deactivate maintenance mode'
        }
      } else {
        maintenanceError = 'Failed to deactivate maintenance mode'
      }
    }
  }

  const verifyEnabled = $derived(verifyFrom.length > 0 && verifyTo.length > 0)
</script>

<svelte:head>
  <title>Platform Operator Audit Log | Platform Admin | Project Vault</title>
</svelte:head>

<PlatformBreadcrumb
  allowed={data.allowed}
  trail={[{ label: 'Platform Admin', href: '/platform' }, { label: 'Platform Operator Audit Log' }]}
>
  <h1 class="text-2xl font-bold text-gray-900">Platform Operator Audit Log</h1>
  <p class="mt-2 text-sm text-gray-500">
    This is a separate log from your organization's own audit log (<a
      href={resolve('/settings/audit')}
      class="underline">Settings → Audit &amp; Compliance</a
    >) — it records platform-operator actions across all organizations, not per-org activity. There
    is no unified cross-log search in this version.
  </p>

  <!-- Maintenance mode status banner (AC-M1) -->
  {#if maintenanceStatusError}
    <div
      class="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900"
      role="alert"
    >
      ⚠ {maintenanceStatusError}
    </div>
  {:else if maintenanceStatus?.active}
    <div
      class="sticky top-0 z-10 mt-4 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3 text-sm text-red-900"
      role="alert"
    >
      <p class="font-bold">⚠ Maintenance mode is ACTIVE</p>
      <p class="mt-1">
        Activated: {maintenanceStatus.activatedAt
          ? new Date(maintenanceStatus.activatedAt).toLocaleString()
          : '—'}
        — Reason: {maintenanceStatus.reason ?? '—'}
        — {maintenanceStatus.pendingEntriesCount} entries queued.
      </p>
      <p class="mt-1 text-xs">The fail-closed audit guarantee is currently bypassed.</p>
    </div>
  {:else if maintenanceStatus}
    <div class="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-600">
      Maintenance mode: inactive
    </div>
  {/if}

  <!-- Search -->
  <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Search</h2>
    <form method="GET" class="mt-4 flex flex-wrap items-end gap-3" onsubmit={handleSearchSubmit}>
      <label class="flex flex-col text-sm text-slate-700" for="filter-actionType">
        Action type
        <input
          id="filter-actionType"
          name="actionType"
          type="text"
          class="rounded-lg border border-slate-300 px-2 py-1"
          value={data.filters?.actionType ?? ''}
        />
      </label>
      <label class="flex flex-col text-sm text-slate-700" for="filter-operatorId">
        Operator ID
        <input
          id="filter-operatorId"
          name="operatorId"
          type="text"
          class="rounded-lg border border-slate-300 px-2 py-1"
          value={data.filters?.operatorId ?? ''}
        />
      </label>
      <label class="flex flex-col text-sm text-slate-700" for="filter-targetOrgId">
        Target org ID
        <input
          id="filter-targetOrgId"
          name="targetOrgId"
          type="text"
          class="rounded-lg border border-slate-300 px-2 py-1"
          value={data.filters?.targetOrgId ?? ''}
        />
      </label>
      <label class="flex flex-col text-sm text-slate-700" for="filter-targetUserId">
        Target user ID
        <input
          id="filter-targetUserId"
          name="targetUserId"
          type="text"
          class="rounded-lg border border-slate-300 px-2 py-1"
          value={data.filters?.targetUserId ?? ''}
        />
      </label>
      {@const activeFilters = data.filters ?? {}}
      <AuditDateRangeInputs
        fromValue={activeFilters.from ?? ''}
        toValue={activeFilters.to ?? ''}
        {dateRangeError}
        hasFilters={Boolean(hasFilters)}
        filterSummaryText={filterSummary(activeFilters)}
        clearHref="?"
      />
    </form>

    {#if data.eventsErrorMessage}
      <p
        class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        role="alert"
      >
        {data.eventsErrorMessage}
      </p>
    {:else}
      <div class="mt-4">
        {#if data.events.length === 0}
          <p class="py-6 text-center text-slate-600">
            {hasFilters
              ? 'No platform audit events match these filters.'
              : 'No platform audit events yet.'}
          </p>
        {:else}
          <DataTable
            columns={[
              'Action type',
              'Operator',
              'Target org',
              'Target user',
              'IP address',
              'Timestamp',
            ]}
          >
            {#each data.events as event (event.id)}
              <tr class="border-b border-slate-100 last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">{event.actionType}</td>
                <td class="px-4 py-3 font-mono text-xs text-slate-600">{event.operatorId}</td>
                <td class="px-4 py-3 font-mono text-xs text-slate-600"
                  >{event.targetOrgId ?? '—'}</td
                >
                <td class="px-4 py-3 font-mono text-xs text-slate-600"
                  >{event.targetUserId ?? '—'}</td
                >
                <td class="px-4 py-3 text-sm text-slate-600">{event.ipAddress ?? '—'}</td>
                <td class="px-4 py-3 text-sm text-slate-600"
                  >{new Date(event.timestamp).toLocaleString()}</td
                >
              </tr>
            {/each}
          </DataTable>

          <AuditPaginationControls
            page={data.page}
            total={data.total}
            hasNext={data.hasNext}
            {pageHref}
          />
        {/if}
      </div>
    {/if}
  </div>

  <!-- Integrity verify panel (AC-L1) -->
  <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Verify Integrity</h2>
    <p class="mt-1 text-sm text-slate-500">
      Run an HMAC integrity check over a date range. Both dates are required.
    </p>
    <form class="mt-4 flex flex-wrap items-end gap-3" onsubmit={(e) => void handleVerify(e)}>
      <label class="flex flex-col text-sm text-slate-700" for="verify-from">
        From
        <input
          id="verify-from"
          type="text"
          bind:value={verifyFrom}
          placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
          class="rounded-lg border border-slate-300 px-2 py-1"
        />
      </label>
      <label class="flex flex-col text-sm text-slate-700" for="verify-to">
        To
        <input
          id="verify-to"
          type="text"
          bind:value={verifyTo}
          placeholder="YYYY-MM-DDTHH:mm:ss.sssZ"
          class="rounded-lg border border-slate-300 px-2 py-1"
        />
      </label>
      <button
        type="submit"
        disabled={!verifyEnabled || verifying}
        class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {verifying ? 'Verifying\u2026' : 'Verify integrity'}
      </button>
    </form>

    {#if verifyError}
      <p
        class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {verifyError}
      </p>
    {/if}

    {#if verifyResult}
      {@const r = verifyResult}
      <div class="mt-4">
        {#if r.failedCount > 0}
          <div class="rounded-lg border border-red-300 bg-red-50 px-4 py-3" role="alert">
            <p class="font-semibold text-red-800">
              ⚠ Tampering detected — {r.failedCount} record(s) failed verification
            </p>
            <p class="mt-1 text-sm text-red-700">{r.summary}</p>
            <ul class="mt-2 space-y-1 text-xs text-red-700">
              {#each r.failed as f (f.id)}
                <li>{f.actionType} at {new Date(f.timestamp).toLocaleString()} (id: {f.id})</li>
              {/each}
              {#if r.failedTruncated}
                <li class="italic">…(truncated)</li>
              {/if}
            </ul>
          </div>
        {:else}
          <p
            class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          >
            ✓ {r.summary}
          </p>
        {/if}
        <p class="mt-2 text-xs text-slate-500">
          {r.rowsChecked} records checked, {r.passed} passed — verified at {new Date(
            r.verifiedAt
          ).toLocaleString()}
        </p>
      </div>
    {/if}
  </div>

  <!-- Maintenance mode panel (AC-M1, M2, M3) -->
  <div class="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 class="text-lg font-semibold text-slate-950">Maintenance Mode</h2>
    <p class="mt-1 text-sm text-slate-500">
      Maintenance mode bypasses the fail-closed audit guarantee to allow recovery during storage
      outages. Use only when the platform audit log is genuinely unavailable.
    </p>

    {#if maintenanceError}
      <p
        class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {maintenanceError}
      </p>
    {/if}
    {#if maintenanceMfaError}
      <MfaAwareErrorAlert
        message={maintenanceMfaError}
        class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      />
    {/if}

    {#if maintenanceStatusError}
      <p class="mt-4 text-sm text-gray-500 italic">
        Actions disabled — maintenance mode status unavailable.
      </p>
    {:else if maintenanceStatus?.active}
      <div class="mt-4">
        <ConfirmDeleteButton
          label="Deactivate maintenance mode"
          confirmLabel="Confirm deactivation?"
          pendingLabel="Deactivating…"
          onConfirm={handleDeactivateMaintenance}
        />
      </div>
    {:else}
      <div class="mt-4 flex flex-col gap-3">
        <label class="flex flex-col text-sm text-gray-700">
          Reason (required to activate)
          <textarea
            class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            rows="2"
            bind:value={activateReason}
            placeholder="Reason for activating maintenance mode"></textarea>
        </label>
        <div>
          <ConfirmDeleteButton
            label="Activate maintenance mode"
            confirmLabel="Confirm activation?"
            pendingLabel="Activating…"
            disabled={activateReason.trim().length === 0}
            onConfirm={handleActivateMaintenance}
          />
        </div>
      </div>
    {/if}
  </div>
</PlatformBreadcrumb>
