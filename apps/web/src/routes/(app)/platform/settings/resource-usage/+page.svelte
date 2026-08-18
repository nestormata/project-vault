<script lang="ts">
  import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
  import PlatformWarningsBanner from '$lib/components/platform/PlatformWarningsBanner.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import DataTable from '$lib/components/tables/DataTable.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    defaultByteInputUnit,
    formatBytes,
    parseByteInput,
    type ByteInputUnit,
  } from '$lib/utils/format-bytes.js'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    setOrgAuditQuota,
    type AuditStorageOrgRow,
    type OrgAuditState,
  } from '$lib/api/platform.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  // Story 22.3 AC-6: defensive against a malformed/missing auditStorageByOrg in an otherwise-200
  // response — never crash the page over an additive field.
  let auditRows = $state<AuditStorageOrgRow[]>(
    data.allowed && data.usage ? (data.usage.auditStorageByOrg ?? []) : []
  )

  const STATE_BADGE: Record<OrgAuditState, { label: string; class: string }> = {
    unlimited: { label: 'Unlimited', class: 'bg-gray-100 text-gray-700' },
    ok: { label: 'Ok', class: 'bg-green-100 text-green-800' },
    warning: { label: 'Warning', class: 'bg-amber-100 text-amber-800' },
    critical: { label: 'Critical', class: 'bg-orange-100 text-orange-800' },
    blocked: { label: 'Blocked', class: 'bg-red-100 text-red-800' },
    stale: { label: 'Stale', class: 'bg-slate-200 text-slate-700' },
  }

  // ---- Inline edit state (AC-5) --------------------------------------------------------------
  let editingOrgId = $state<string | null>(null)
  let quotaValue = $state('')
  let quotaUnit = $state<ByteInputUnit>('GB')
  let rateValue = $state('')
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let saveMfaError = $state<string | null>(null)
  let saveSuccessOrgId = $state<string | null>(null)
  let belowUsagePending = $state(false)
  let overcommitPending = $state<{
    allocatedLogicalBytes: number
    estimatedPhysicalBytes: number
    instanceLimitBytes: number
    requestedBytes: number
  } | null>(null)

  function startEdit(row: AuditStorageOrgRow): void {
    editingOrgId = row.orgId
    quotaUnit = defaultByteInputUnit(row.quotaBytes)
    quotaValue =
      row.quotaBytes === null
        ? ''
        : String(row.quotaBytes / (quotaUnit === 'GB' ? 1024 ** 3 : 1024 ** 2))
    rateValue = row.writeRatePerMinute === null ? '' : String(row.writeRatePerMinute)
    saveError = null
    saveMfaError = null
    belowUsagePending = false
    overcommitPending = null
  }

  function cancelEdit(): void {
    editingOrgId = null
    belowUsagePending = false
    overcommitPending = null
  }

  async function submitEdit(
    row: AuditStorageOrgRow,
    opts: { acknowledgeOvercommit?: boolean; skipBelowUsageCheck?: boolean } = {}
  ): Promise<void> {
    // Svelte's `bind:value` on a `type="number"` input coerces the bound value to a JS number
    // once numeric text is entered (not a string) — normalize with String() before trimming so
    // this handles both the empty-string initial state and a post-input numeric value.
    const trimmedQuota = String(quotaValue ?? '').trim()
    const quotaBytes = trimmedQuota === '' ? null : parseByteInput(Number(trimmedQuota), quotaUnit)
    const trimmedRate = String(rateValue ?? '').trim()
    const writeRatePerMinute = trimmedRate === '' ? null : Number(trimmedRate)

    // Second-Order Thinking finding (elicitation round 4): a fat-fingered low quota immediately
    // blocks the org's audit writes — confirm before submitting, client-side only (the API itself
    // must still accept the request unconditionally per AC-3's own required test).
    if (!opts.skipBelowUsageCheck && quotaBytes !== null && quotaBytes < row.bytesUsed) {
      belowUsagePending = true
      return
    }

    saving = true
    saveError = null
    saveMfaError = null
    saveSuccessOrgId = null
    try {
      const updated = await setOrgAuditQuota(fetch, row.orgId, {
        quotaBytes,
        writeRatePerMinute,
        ...(opts.acknowledgeOvercommit ? { acknowledgeOvercommit: true as const } : {}),
      })
      auditRows = auditRows.map((r) => (r.orgId === row.orgId ? updated : r))
      editingOrgId = null
      belowUsagePending = false
      overcommitPending = null
      saveSuccessOrgId = row.orgId
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          saveMfaError = err.message ?? 'MFA required'
        } else if (err.status === 422 && err.code === 'quota_overcommit') {
          const body = err.body as {
            allocatedLogicalBytes?: number
            estimatedPhysicalBytes?: number
            instanceLimitBytes?: number
            requestedBytes?: number
          } | null
          overcommitPending = {
            allocatedLogicalBytes: body?.allocatedLogicalBytes ?? 0,
            estimatedPhysicalBytes: body?.estimatedPhysicalBytes ?? 0,
            instanceLimitBytes: body?.instanceLimitBytes ?? 0,
            requestedBytes: body?.requestedBytes ?? quotaBytes ?? 0,
          }
        } else if (err.status === 404) {
          saveError = err.message ?? 'Organization not found — it may have just been deleted.'
        } else {
          saveError = err.message ?? 'Failed to update quota'
        }
      } else {
        saveError = 'Failed to update quota'
      }
    } finally {
      saving = false
    }
  }

  const WARNING_MESSAGES: Record<string, { message: string }> = {
    audit_storage_critical: {
      message:
        'Audit log storage is at critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`.',
    },
    key_custody_risk: {
      message:
        'Master key custody risk: a single lost key file means unrecoverable data, or the key hasn\u2019t been rotated recently.',
    },
  }

  function thresholdClass(pct: number | null): string {
    if (pct === null) return 'text-gray-700'
    if (pct >= 95) return 'font-bold text-red-700'
    if (pct >= 90) return 'font-semibold text-orange-600'
    if (pct >= 80) return 'text-amber-600'
    return 'text-gray-700'
  }

  function thresholdLabel(pct: number | null): string {
    if (pct === null) return ''
    if (pct >= 95) return 'Critical'
    if (pct >= 90) return 'High usage'
    if (pct >= 80) return 'Approaching limit'
    return ''
  }

  function pct(current: number, limit: number | null): number | null {
    if (limit === null || limit === 0) return null
    return Math.round((current / limit) * 100)
  }
</script>

<svelte:head>
  <title>Resource Usage | Platform Admin | Project Vault</title>
</svelte:head>

<PlatformSettingsBreadcrumb allowed={data.allowed} leafLabel="Resource Usage">
  <h1 class="text-2xl font-bold text-gray-900">Resource Usage</h1>
  <p class="mt-1 text-gray-500">Monitor instance-wide resource consumption and limits.</p>

  <PlatformWarningsBanner warnings={data.warnings} messages={WARNING_MESSAGES} />

  {#if data.errorMessage}
    <MfaAwareErrorAlert
      message={data.errorMessage}
      class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    />
  {:else if data.usage}
    {@const u = data.usage}
    {@const allocation = {
      truncated: u.truncated ?? false,
      allocatedLogicalBytes: u.allocatedLogicalBytes ?? 0,
      estimatedPhysicalBytes: u.estimatedPhysicalBytes ?? 0,
      allocationIncludesUnlimitedOrgs: u.allocationIncludesUnlimitedOrgs ?? false,
      observedPhysicalToLogicalRatio: u.observedPhysicalToLogicalRatio ?? null,
    }}
    <div class="mt-6 space-y-6">
      <!-- Orgs -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Organizations</h2>
        <p class="mt-2 text-sm">
          <span class={thresholdClass(pct(u.orgs.current, u.orgs.limit))}>
            {u.orgs.current} / {u.orgs.limit ?? 'No limit configured'}
            {#if pct(u.orgs.current, u.orgs.limit) !== null}({pct(
                u.orgs.current,
                u.orgs.limit
              )}%){/if}
          </span>
          {#if thresholdLabel(pct(u.orgs.current, u.orgs.limit))}
            <span class="ml-2 text-xs font-semibold"
              >{thresholdLabel(pct(u.orgs.current, u.orgs.limit))}</span
            >
          {/if}
        </p>
      </section>

      <!-- Users per org -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Users per Organization</h2>
        <div class="mt-2 divide-y divide-gray-100">
          {#each u.usersPerOrg as row (row.orgId)}
            {@const userPct = pct(row.current, row.limit)}
            <div class="flex items-center justify-between py-2 text-sm">
              <span class="font-mono text-xs text-gray-500">{row.orgId}</span>
              <span class={thresholdClass(userPct)}>
                {row.current} / {row.limit ?? 'No limit'}
                {#if userPct !== null}({userPct}%){/if}
                {#if thresholdLabel(userPct)}<span class="ml-1 text-xs font-semibold"
                    >{thresholdLabel(userPct)}</span
                  >{/if}
              </span>
            </div>
          {/each}
        </div>
      </section>

      <!-- Audit log entries -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Audit Log Entries</h2>
        <p class="mt-2 text-sm">
          <span class={thresholdClass(pct(u.auditLogEntries.current, u.auditLogEntries.limit))}>
            {u.auditLogEntries.current.toLocaleString()} / {u.auditLogEntries.limit?.toLocaleString() ??
              'No limit configured'}
            {#if pct(u.auditLogEntries.current, u.auditLogEntries.limit) !== null}
              ({pct(u.auditLogEntries.current, u.auditLogEntries.limit)}%)
            {/if}
          </span>
        </p>
      </section>

      <!-- Storage bytes -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Storage</h2>
        <p class="mt-2 text-sm">
          <span class={thresholdClass(pct(u.storageBytes.current, u.storageBytes.limit))}>
            {formatBytes(u.storageBytes.current)} / {u.storageBytes.limit !== null
              ? formatBytes(u.storageBytes.limit)
              : 'No limit configured'}
            {#if pct(u.storageBytes.current, u.storageBytes.limit) !== null}
              ({pct(u.storageBytes.current, u.storageBytes.limit)}%)
            {/if}
          </span>
        </p>
      </section>

      <!-- Audit log storage (use backend-computed utilizationPct directly) -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Audit Log Storage (physical)</h2>
        <p class="mt-2 text-sm">
          <span class={thresholdClass(u.auditLogStorage.utilizationPct)}>
            {formatBytes(u.auditLogStorage.currentBytes)} / {formatBytes(
              u.auditLogStorage.limitBytes
            )}
            ({u.auditLogStorage.utilizationPct}%)
          </span>
          {#if thresholdLabel(u.auditLogStorage.utilizationPct)}
            <span class="ml-2 text-xs font-semibold">
              {thresholdLabel(u.auditLogStorage.utilizationPct)} — critical threshold is 95%.
            </span>
          {/if}
        </p>
      </section>

      <!-- Story 22.3: per-org audit-storage table (AC-5/AC-6/AC-7) -->
      <section class="rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">Audit Storage by Organization</h2>

        {#if auditRows.length > 0}
          {@const allocatedPct =
            allocation.estimatedPhysicalBytes && u.auditLogStorage.limitBytes
              ? Math.round(
                  (allocation.estimatedPhysicalBytes / u.auditLogStorage.limitBytes) * 1000
                ) / 10
              : 0}
          <p class="mt-2 text-sm text-gray-700">
            {allocation.allocationIncludesUnlimitedOrgs ? '≥' : '≈'}
            Σ per-organization quotas: {formatBytes(allocation.allocatedLogicalBytes)} logical (≈ {formatBytes(
              allocation.estimatedPhysicalBytes
            )} estimated physical, {allocatedPct}% of the {formatBytes(
              u.auditLogStorage.limitBytes
            )} instance limit)
            {#if allocation.allocationIncludesUnlimitedOrgs}
              <span class="block text-xs text-amber-700"
                >One or more organizations are unlimited — this is a lower bound; the true figure
                may be higher.</span
              >
            {/if}
            {#if allocation.observedPhysicalToLogicalRatio !== null}
              <span class="block text-xs text-gray-500">
                Observed ratio: {Math.round(allocation.observedPhysicalToLogicalRatio * 100) / 100}×
                — static estimate used for the bound above.
              </span>
            {/if}
          </p>
        {/if}

        {#if allocation.truncated}
          <p class="mt-2 text-xs text-amber-700" role="status">
            Showing the {auditRows.length} highest-utilization organizations of more on this instance.
          </p>
        {/if}

        {#if auditRows.some((r) => r.state === 'stale')}
          <p
            class="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
          >
            Audit-storage usage figures may be out of date — the reconciliation job has not run
            recently for one or more organizations.
          </p>
        {/if}

        <div class="mt-4">
          {#if auditRows.length === 0}
            <p
              class="rounded-lg border border-gray-200 bg-white px-6 py-8 text-center text-gray-500"
            >
              No organizations yet.
            </p>
          {:else}
            <DataTable
              columns={[
                'Organization',
                'Used',
                'Quota',
                'Utilization',
                'Write Rate',
                'State',
                'Actions',
              ]}
            >
              {#each auditRows as row (row.orgId)}
                {@const badge = STATE_BADGE[row.state]}
                <tr class="border-b border-slate-100 last:border-b-0">
                  <td class="px-4 py-3 text-sm">
                    <div class="font-medium text-slate-900">{row.orgName}</div>
                    <div class="font-mono text-xs text-slate-500">{row.orgId}</div>
                  </td>
                  <td class="px-4 py-3 text-sm text-slate-700"
                    >{formatBytes(row.bytesUsed)} (logical)</td
                  >
                  <td class="px-4 py-3 text-sm text-slate-700">
                    {row.quotaBytes === null
                      ? 'No quota configured'
                      : `${formatBytes(row.quotaBytes)} (logical)`}
                  </td>
                  <td class="px-4 py-3 text-sm text-slate-700">
                    {#if row.state === 'stale'}
                      Stale — {row.lastReconciledAt
                        ? `last reconciled ${new Date(row.lastReconciledAt).toLocaleDateString()}`
                        : 'never reconciled'}
                    {:else if row.utilizationPct === null}
                      —
                    {:else}
                      {row.utilizationPct}%
                    {/if}
                  </td>
                  <td class="px-4 py-3 text-sm text-slate-700">
                    {row.writeRatePerMinute === null
                      ? 'Unlimited'
                      : `${row.writeRatePerMinute}/min`}
                  </td>
                  <td class="px-4 py-3 text-sm">
                    <span
                      class={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${badge.class}`}
                    >
                      {badge.label}
                    </span>
                    {#if row.state === 'blocked'}
                      <span class="ml-1 text-xs text-red-700">may already be refusing writes</span>
                    {/if}
                  </td>
                  <td class="px-4 py-3 text-sm">
                    {#if editingOrgId !== row.orgId}
                      <button
                        type="button"
                        class="rounded-lg border border-gray-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-gray-50"
                        onclick={() => startEdit(row)}
                      >
                        Edit
                      </button>
                      {#if saveSuccessOrgId === row.orgId}
                        <span class="ml-1 text-xs text-green-700" role="status">Saved</span>
                      {/if}
                    {/if}
                  </td>
                </tr>
                {#if editingOrgId === row.orgId}
                  <tr class="border-b border-slate-100 bg-slate-50 last:border-b-0">
                    <td colspan="7" class="px-4 py-4">
                      <form
                        class="flex flex-wrap items-end gap-3"
                        onsubmit={(e) => {
                          e.preventDefault()
                          void submitEdit(row)
                        }}
                      >
                        <label class="flex flex-col text-xs text-gray-700">
                          Quota
                          <span class="mt-1 flex gap-1">
                            <input
                              type="number"
                              min="0"
                              step="any"
                              bind:value={quotaValue}
                              placeholder="Unlimited"
                              aria-describedby="audit-quota-help-{row.orgId}"
                              class="w-28 rounded border border-gray-300 px-2 py-1 text-sm"
                            />
                            <select
                              bind:value={quotaUnit}
                              aria-describedby="audit-quota-unit-help-{row.orgId}"
                              class="rounded border border-gray-300 px-1 py-1 text-sm"
                            >
                              <option value="MB">MB</option>
                              <option value="GB">GB</option>
                            </select>
                          </span>
                          <FormHelpText
                            id="audit-quota-help-{row.orgId}"
                            kind="text"
                            text="Leave blank for unlimited. Enter a value and choose MB or GB."
                          />
                          <FormHelpText
                            id="audit-quota-unit-help-{row.orgId}"
                            kind="select"
                            text="Unit for the quota value."
                          />
                        </label>
                        <label class="flex flex-col text-xs text-gray-700">
                          Write rate (writes/min)
                          <input
                            type="number"
                            min="0"
                            step="1"
                            bind:value={rateValue}
                            placeholder="Unlimited"
                            aria-describedby="audit-rate-help-{row.orgId}"
                            class="mt-1 w-32 rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                          <FormHelpText
                            id="audit-rate-help-{row.orgId}"
                            kind="text"
                            text="Leave blank for unlimited writes per minute."
                          />
                        </label>
                        <button
                          type="submit"
                          disabled={saving}
                          class="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          class="rounded-xl border border-gray-300 px-3 py-1.5 text-xs font-semibold text-slate-700"
                          onclick={cancelEdit}
                        >
                          Cancel
                        </button>
                      </form>

                      {#if belowUsagePending}
                        <div
                          class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                          role="alert"
                        >
                          This organization is currently using {formatBytes(row.bytesUsed)}. Setting
                          a lower quota will immediately block its audit writes until usage drops.
                          Continue?
                          <button
                            type="button"
                            class="ml-2 rounded border border-amber-400 px-2 py-1 font-semibold"
                            onclick={() => void submitEdit(row, { skipBelowUsageCheck: true })}
                          >
                            Continue anyway
                          </button>
                        </div>
                      {/if}

                      {#if overcommitPending}
                        <div
                          class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                          role="alert"
                        >
                          This would allocate an estimated {formatBytes(
                            overcommitPending.estimatedPhysicalBytes
                          )} of physical storage against a {formatBytes(
                            overcommitPending.instanceLimitBytes
                          )} instance limit. Continue anyway?
                          <button
                            type="button"
                            class="ml-2 rounded border border-amber-400 px-2 py-1 font-semibold"
                            onclick={() =>
                              void submitEdit(row, {
                                acknowledgeOvercommit: true,
                                skipBelowUsageCheck: true,
                              })}
                          >
                            Continue anyway
                          </button>
                        </div>
                      {/if}

                      {#if saveError}
                        <p class="mt-3 text-xs text-red-700" role="alert">{saveError}</p>
                      {/if}
                      {#if saveMfaError}
                        <MfaAwareErrorAlert
                          message={saveMfaError}
                          class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                        />
                      {/if}
                    </td>
                  </tr>
                {/if}
              {/each}
            </DataTable>
          {/if}
        </div>

        <p class="mt-3 text-xs text-gray-500">
          Per-organization figures count row data only (logical bytes); the instance total above
          includes indexes, padding and storage overhead (physical bytes) and does not equal the sum
          of the rows below.
        </p>
      </section>
    </div>
  {/if}
</PlatformSettingsBreadcrumb>
