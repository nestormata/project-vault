<script lang="ts">
  import PlatformSettingsBreadcrumb from '$lib/components/platform/PlatformSettingsBreadcrumb.svelte'
  import PlatformWarningsBanner from '$lib/components/platform/PlatformWarningsBanner.svelte'
  import { formatBytes } from '$lib/utils/format-bytes.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

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
    <p
      class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {data.errorMessage}
    </p>
  {:else if data.usage}
    {@const u = data.usage}
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
        <h2 class="text-base font-semibold text-gray-900">Audit Log Storage</h2>
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
    </div>
  {/if}
</PlatformSettingsBreadcrumb>
