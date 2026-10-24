<script lang="ts">
  import { describeBackupCron } from '@project-vault/shared'
  import { resolve } from '$app/paths'
  import type { EffectiveBackupSettings } from '$lib/api/platform.js'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import CronScheduleHelp from '$lib/components/forms/CronScheduleHelp.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the Backup card of the system settings (effective values plus the two overrides) as
  // one replaceable region. The settings form owns the editing state.
  let {
    scheduleOverride = $bindable(),
    retentionCountOverride = $bindable(),
    backup,
    data,
  }: {
    scheduleOverride: string
    retentionCountOverride: string
    backup: EffectiveBackupSettings
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const cronLocale = getLocale() === 'es' ? 'es' : 'en'
  const scheduleInterpretation = $derived(describeBackupCron(scheduleOverride.trim(), cronLocale))
</script>

<!-- @region platform.settings.backup -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-gray-900">Backup</h2>
  <p class="mt-1 text-sm text-gray-500">
    Effective: Schedule <code class="font-mono">{backup.schedule}</code>, Retention {backup.retentionCount}
    backups, Storage {backup.storageType ?? 'not configured'}.
    <a href={resolve('/platform/backups')} class="ml-2 font-medium text-indigo-600 underline">
      → Manage backups
    </a>
  </p>
  <div class="mt-4 grid grid-cols-2 gap-4">
    <div class="flex flex-col text-sm text-gray-700">
      <div class="flex items-center gap-2">
        <label for="backup-schedule-override">Schedule override (cron)</label>
        <CronScheduleHelp id="backup-schedule-cron-help" />
      </div>
      <input
        id="backup-schedule-override"
        type="text"
        bind:value={scheduleOverride}
        placeholder="Leave blank to keep default"
        class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
        aria-describedby="backup-schedule-help"
      />
      {#if scheduleInterpretation}
        <p class="mt-1 text-sm text-gray-600">
          {m.form_help_rotation_interpretation({ description: scheduleInterpretation })}
        </p>
      {/if}
    </div>
    <FormHelpText id="backup-schedule-help" kind="text" />
    <label class="flex flex-col text-sm text-gray-700">
      Retention count override
      <input
        type="number"
        bind:value={retentionCountOverride}
        placeholder="Leave blank to keep default"
        class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
        aria-describedby="backup-retention-help"
      />
    </label>
    <FormHelpText id="backup-retention-help" kind="date" /><InjectionPoint
      name="platform.settings.backup"
      {data}
    />
  </div>
</section>
