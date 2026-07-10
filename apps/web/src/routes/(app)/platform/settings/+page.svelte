<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { updateSettings, type SystemSettingsUpdate } from '$lib/api/platform.js'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  let settings = $state(data.allowed ? data.settings : null)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let saveMfaError = $state<string | null>(null)
  let saveSuccess = $state(false)
  let fieldErrors = $state<Record<string, string>>({})

  // Form fields — initialized from settings
  let smtpHost = $state(settings?.smtp.host ?? '')
  let smtpPort = $state(settings?.smtp.port?.toString() ?? '')
  let smtpUser = $state(settings?.smtp.user ?? '')
  let smtpFrom = $state(settings?.smtp.from ?? '')
  let smtpPassword = $state('')

  let scheduleOverride = $state('')
  let retentionCountOverride = $state('')
  let defaultSlackWebhook = $state(settings?.notifications.defaultSlackWebhook ?? '')
  let maxOrgs = $state(settings?.instancePolicy.maxOrgs?.toString() ?? '')
  let maxUsersPerOrg = $state(settings?.instancePolicy.maxUsersPerOrg?.toString() ?? '')
  let sessionIdleTimeoutMinutes = $state(
    settings?.instancePolicy.sessionIdleTimeoutMinutes?.toString() ?? ''
  )

  async function handleSave() {
    saving = true
    saveError = null
    saveMfaError = null
    saveSuccess = false
    fieldErrors = {}

    const update: SystemSettingsUpdate = {}

    const smtpPatch: SystemSettingsUpdate['smtp'] = {}
    if (smtpHost.trim()) smtpPatch.host = smtpHost.trim()
    if (smtpPort.trim()) smtpPatch.port = Number(smtpPort)
    if (smtpUser.trim()) smtpPatch.user = smtpUser.trim()
    if (smtpFrom.trim()) smtpPatch.from = smtpFrom.trim()
    if (smtpPassword.trim()) smtpPatch.password = smtpPassword.trim()
    if (Object.keys(smtpPatch).length > 0) update.smtp = smtpPatch

    const backupPatch: SystemSettingsUpdate['backup'] = {}
    if (scheduleOverride.trim()) backupPatch.scheduleOverride = scheduleOverride.trim()
    if (retentionCountOverride.trim())
      backupPatch.retentionCountOverride = Number(retentionCountOverride)
    if (Object.keys(backupPatch).length > 0) update.backup = backupPatch

    const notifPatch: SystemSettingsUpdate['notifications'] = {}
    if (defaultSlackWebhook.trim()) notifPatch.defaultSlackWebhookUrl = defaultSlackWebhook.trim()
    if (Object.keys(notifPatch).length > 0) update.notifications = notifPatch

    const policyPatch: SystemSettingsUpdate['instancePolicy'] = {}
    if (maxOrgs.trim()) policyPatch.maxOrgs = Number(maxOrgs)
    if (maxUsersPerOrg.trim()) policyPatch.maxUsersPerOrg = Number(maxUsersPerOrg)
    if (sessionIdleTimeoutMinutes.trim())
      policyPatch.sessionIdleTimeoutMinutes = Number(sessionIdleTimeoutMinutes)
    if (Object.keys(policyPatch).length > 0) update.instancePolicy = policyPatch

    try {
      const updated = await updateSettings(fetch, update)
      settings = updated
      smtpPassword = ''
      saveSuccess = true
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 403 && err.code === 'mfa_required') {
          saveMfaError = err.message ?? 'MFA required'
        } else if (err.status === 422 && err.details) {
          const details = err.details as Array<{ path?: string[]; message?: string }>
          if (Array.isArray(details)) {
            const errs: Record<string, string> = {}
            for (const d of details) {
              if (d.path && d.path.length > 0) errs[d.path.join('.')] = d.message ?? 'Invalid'
            }
            fieldErrors = errs
          } else {
            saveError = err.message ?? 'Validation failed'
          }
        } else if (err.status === 503) {
          const body = err.body as { status?: string; message?: string } | null
          if (body && 'status' in body && !('code' in body)) {
            saveError = 'The vault was sealed while you were on this page — unseal it to continue.'
          } else {
            saveError = err.message ?? 'Service unavailable'
          }
        } else {
          saveError = err.message ?? 'Failed to save settings'
        }
      } else {
        saveError = 'Failed to save settings'
      }
    } finally {
      saving = false
    }
  }
</script>

<svelte:head>
  <title>System Settings | Platform Admin | Project Vault</title>
</svelte:head>

{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <nav class="mb-4 text-sm text-gray-500">
      <a href={resolve('/platform')} class="hover:underline">Platform Admin</a>
      <span class="mx-2">›</span>
      <span>System Settings</span>
    </nav>

    <h1 class="text-2xl font-bold text-gray-900">System Settings</h1>
    <p class="mt-1 text-gray-500">Configure SMTP, notifications, and instance policy.</p>

    <div class="mt-4 flex gap-4 text-sm">
      <a href={resolve('/platform/settings/orgs')} class="font-medium text-indigo-600 underline">
        Organizations →
      </a>
      <a
        href={resolve('/platform/settings/resource-usage')}
        class="font-medium text-indigo-600 underline"
      >
        Resource Usage →
      </a>
    </div>

    {#if data.errorMessage}
      <MfaAwareErrorAlert
        message={data.errorMessage}
        class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      />
    {:else if settings}
      {#if saveSuccess}
        <p
          class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          role="status"
        >
          Settings saved successfully.
        </p>
      {/if}
      {#if saveError}
        <p
          class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {saveError}
        </p>
      {/if}
      {#if saveMfaError}
        <MfaAwareErrorAlert
          message={saveMfaError}
          class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        />
      {/if}

      <form
        class="mt-6 space-y-8"
        onsubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
      >
        <!-- SMTP -->
        <section class="rounded-xl border border-gray-200 bg-white p-6">
          <h2 class="text-lg font-semibold text-gray-900">SMTP</h2>
          {#if settings.smtp.configured}
            <p class="mt-1 text-xs text-green-700">✓ Password is currently set</p>
          {/if}
          <div class="mt-4 grid grid-cols-2 gap-4">
            <label class="flex flex-col text-sm text-gray-700">
              Host
              <input
                type="text"
                bind:value={smtpHost}
                placeholder={settings.smtp.host ?? ''}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              Port
              <input
                type="number"
                bind:value={smtpPort}
                placeholder={settings.smtp.port?.toString() ?? ''}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              Username
              <input
                type="text"
                bind:value={smtpUser}
                placeholder={settings.smtp.user ?? ''}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              From address
              <input
                type="email"
                bind:value={smtpFrom}
                placeholder={settings.smtp.from ?? ''}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              {#if fieldErrors['smtp.from']}
                <span class="text-xs text-red-600">{fieldErrors['smtp.from']}</span>
              {/if}
            </label>
            <label class="col-span-2 flex flex-col text-sm text-gray-700">
              Password
              <input
                type="password"
                bind:value={smtpPassword}
                placeholder="Leave blank to keep the current password"
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        </section>

        <!-- Backup (effective, read-only + overrides) -->
        <section class="rounded-xl border border-gray-200 bg-white p-6">
          <h2 class="text-lg font-semibold text-gray-900">Backup</h2>
          <p class="mt-1 text-sm text-gray-500">
            Effective: Schedule <code class="font-mono">{settings.backup.schedule}</code>, Retention {settings
              .backup.retentionCount} backups, Storage {settings.backup.storageType ??
              'not configured'}.
            <a
              href={resolve('/platform/backups')}
              class="ml-2 font-medium text-indigo-600 underline"
            >
              → Manage backups
            </a>
          </p>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <label class="flex flex-col text-sm text-gray-700">
              Schedule override (cron)
              <input
                type="text"
                bind:value={scheduleOverride}
                placeholder="Leave blank to keep default"
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
              />
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              Retention count override
              <input
                type="number"
                bind:value={retentionCountOverride}
                placeholder="Leave blank to keep default"
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        </section>

        <!-- Notifications -->
        <section class="rounded-xl border border-gray-200 bg-white p-6">
          <h2 class="text-lg font-semibold text-gray-900">Notifications</h2>
          <label class="mt-4 flex flex-col text-sm text-gray-700">
            Default Slack webhook URL
            <input
              type="url"
              bind:value={defaultSlackWebhook}
              placeholder={settings.notifications.defaultSlackWebhook ??
                'https://hooks.slack.com/…'}
              class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
        </section>

        <!-- Instance policy -->
        <section class="rounded-xl border border-gray-200 bg-white p-6">
          <h2 class="text-lg font-semibold text-gray-900">Instance Policy</h2>
          <div class="mt-4 grid grid-cols-2 gap-4">
            <label class="flex flex-col text-sm text-gray-700">
              Max orgs
              <input
                type="number"
                bind:value={maxOrgs}
                placeholder={settings.instancePolicy.maxOrgs.toString()}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              {#if fieldErrors['instancePolicy.maxOrgs']}
                <span class="text-xs text-red-600">{fieldErrors['instancePolicy.maxOrgs']}</span>
              {/if}
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              Max users per org
              <input
                type="number"
                bind:value={maxUsersPerOrg}
                placeholder={settings.instancePolicy.maxUsersPerOrg.toString()}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
              {#if fieldErrors['instancePolicy.maxUsersPerOrg']}
                <span class="text-xs text-red-600"
                  >{fieldErrors['instancePolicy.maxUsersPerOrg']}</span
                >
              {/if}
            </label>
            <label class="flex flex-col text-sm text-gray-700">
              Session idle timeout (minutes)
              <input
                type="number"
                bind:value={sessionIdleTimeoutMinutes}
                placeholder={settings.instancePolicy.sessionIdleTimeoutMinutes.toString()}
                class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
        </section>

        <div class="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            class="rounded-xl bg-slate-950 px-6 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    {/if}
  </div>
{/if}
