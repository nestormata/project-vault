<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  const WARNING_MESSAGES: Record<string, { message: string }> = {
    audit_storage_critical: {
      message:
        'Audit log storage is at critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`.',
    },
    key_custody_risk: {
      message:
        "Master key custody risk: a single lost key file means unrecoverable data, or the key hasn't been rotated recently.",
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

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }

  function pct(current: number, limit: number | null): number | null {
    if (limit === null || limit === 0) return null
    return Math.round((current / limit) * 100)
  }
</script>

<svelte:head>
  <title>Resource Usage | Platform Admin | Project Vault</title>
</svelte:head>

{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-4xl px-4 py-8">
    <nav class="mb-4 text-sm text-gray-500">
      <a href={resolve('/platform')} class="hover:underline">Platform Admin</a>
      <span class="mx-2">›</span>
      <a href={resolve('/platform/settings')} class="hover:underline">System Settings</a>
      <span class="mx-2">›</span>
      <span>Resource Usage</span>
    </nav>

    <h1 class="text-2xl font-bold text-gray-900">Resource Usage</h1>
    <p class="mt-1 text-gray-500">Monitor instance-wide resource consumption and limits.</p>

    {#each data.warnings as warning (warning)}
      {@const info = WARNING_MESSAGES[warning]}
      {#if info}
        <div
          class="mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="alert"
        >
          <span aria-hidden="true" class="mt-0.5 shrink-0">⚠</span>
          <span>{info.message}</span>
        </div>
      {/if}
    {/each}

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
          {@const orgPct = pct(u.orgs.current, u.orgs.limit)}
          <p class="mt-2 text-sm">
            <span class={thresholdClass(orgPct)}>
              {u.orgs.current} / {u.orgs.limit ?? 'No limit configured'}
              {#if orgPct !== null}({orgPct}%){/if}
            </span>
            {#if thresholdLabel(orgPct)}
              <span class="ml-2 text-xs font-semibold">{thresholdLabel(orgPct)}</span>
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
          {@const auditPct = pct(u.auditLogEntries.current, u.auditLogEntries.limit)}
          <p class="mt-2 text-sm">
            <span class={thresholdClass(auditPct)}>
              {u.auditLogEntries.current.toLocaleString()} / {u.auditLogEntries.limit?.toLocaleString() ??
                'No limit configured'}
              {#if auditPct !== null}({auditPct}%){/if}
            </span>
          </p>
        </section>

        <!-- Storage bytes -->
        <section class="rounded-xl border border-gray-200 bg-white p-6">
          <h2 class="text-base font-semibold text-gray-900">Storage</h2>
          {@const storagePct = pct(u.storageBytes.current, u.storageBytes.limit)}
          <p class="mt-2 text-sm">
            <span class={thresholdClass(storagePct)}>
              {formatBytes(u.storageBytes.current)} / {u.storageBytes.limit !== null
                ? formatBytes(u.storageBytes.limit)
                : 'No limit configured'}
              {#if storagePct !== null}({storagePct}%){/if}
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
  </div>
{/if}
