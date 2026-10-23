<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    updateSettings,
    type SystemSettingsResponse,
    type SystemSettingsUpdate,
  } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import PlatformSettingsBackup from './PlatformSettingsBackup.svelte'
  import PlatformSettingsNotifications from './PlatformSettingsNotifications.svelte'
  import PlatformSettingsPolicy from './PlatformSettingsPolicy.svelte'
  import PlatformSettingsSaveStatus from './PlatformSettingsSaveStatus.svelte'
  import PlatformSettingsSmtp from './PlatformSettingsSmtp.svelte'

  // Story 69.10: the system settings form (save banners plus the SMTP, Backup, Notifications and
  // Instance Policy cards) as one replaceable region. This component owns every field's editing
  // state and the save outcome (moved verbatim from the content component); the cards edit it
  // through bindable props.
  let {
    initialSettings,
    data,
  }: {
    initialSettings: SystemSettingsResponse
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 68.1 AC-3: writable $derived — a new load replaces it; a successful save updates it.
  let settings = $derived(initialSettings)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let saveMfaError = $state<string | null>(null)
  let saveSuccess = $state(false)
  let fieldErrors = $state<Record<string, string>>({})
  // Form fields — initialized from settings.
  // Story 68.1 AC-3: each editable field is a writable $derived of a *primitive* persisted value.
  // A primitive $derived only notifies when its value actually changes, so a reload that returns
  // the same persisted settings leaves an in-progress edit alone, while a changed persisted value
  // (after a save, or another operator's change) re-seeds the field.
  const persistedSmtpHost = $derived(settings?.smtp.host ?? '')
  const persistedSmtpPort = $derived(settings?.smtp.port?.toString() ?? '')
  const persistedSmtpUser = $derived(settings?.smtp.user ?? '')
  const persistedSmtpFrom = $derived(settings?.smtp.from ?? '')
  const persistedSlackWebhook = $derived(settings?.notifications.defaultSlackWebhook ?? '')
  const persistedMaxOrgs = $derived(settings?.instancePolicy.maxOrgs?.toString() ?? '')
  const persistedMaxUsersPerOrg = $derived(
    settings?.instancePolicy.maxUsersPerOrg?.toString() ?? ''
  )
  const persistedSessionIdleTimeout = $derived(
    settings?.instancePolicy.sessionIdleTimeoutMinutes?.toString() ?? ''
  )
  let smtpHost = $derived(persistedSmtpHost)
  let smtpPort = $derived(persistedSmtpPort)
  let smtpUser = $derived(persistedSmtpUser)
  let smtpFrom = $derived(persistedSmtpFrom)
  let smtpPassword = $state('')
  let scheduleOverride = $state('')
  let retentionCountOverride = $state('')
  let defaultSlackWebhook = $derived(persistedSlackWebhook)
  let maxOrgs = $derived(persistedMaxOrgs)
  let maxUsersPerOrg = $derived(persistedMaxUsersPerOrg)
  let sessionIdleTimeoutMinutes = $derived(persistedSessionIdleTimeout)
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

<!-- @region platform.settings.form -->
<RegionFragment>
  <PlatformSettingsSaveStatus {saveSuccess} {saveError} {saveMfaError} {data} />

  <form
    method="post"
    class="mt-6 space-y-8"
    onsubmit={(e) => {
      e.preventDefault()
      void handleSave()
    }}
  >
    <PlatformSettingsSmtp
      bind:smtpHost
      bind:smtpPort
      bind:smtpUser
      bind:smtpFrom
      bind:smtpPassword
      smtp={settings.smtp}
      {fieldErrors}
      {data}
    />
    <PlatformSettingsBackup
      bind:scheduleOverride
      bind:retentionCountOverride
      backup={settings.backup}
      {data}
    />
    <PlatformSettingsNotifications
      bind:defaultSlackWebhook
      notifications={settings.notifications}
      {data}
    />
    <PlatformSettingsPolicy
      bind:maxOrgs
      bind:maxUsersPerOrg
      bind:sessionIdleTimeoutMinutes
      policy={settings.instancePolicy}
      {fieldErrors}
      {data}
    /><InjectionPoint name="platform.settings.form" {data} />

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
</RegionFragment>
