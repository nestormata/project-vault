<script lang="ts">
  import type { EffectiveSmtpSettings } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformSettingsSmtpAccount from './PlatformSettingsSmtpAccount.svelte'
  import PlatformSettingsSmtpServer from './PlatformSettingsSmtpServer.svelte'

  // Story 69.10: the SMTP card of the system settings as one replaceable region (server and account
  // field groups are sub-regions). The settings form owns the editing state.
  let {
    smtpHost = $bindable(),
    smtpPort = $bindable(),
    smtpUser = $bindable(),
    smtpFrom = $bindable(),
    smtpPassword = $bindable(),
    smtp,
    fieldErrors,
    data,
  }: {
    smtpHost: string
    smtpPort: string
    smtpUser: string
    smtpFrom: string
    smtpPassword: string
    smtp: EffectiveSmtpSettings
    fieldErrors: Record<string, string>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.smtp -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-gray-900">SMTP</h2>
  {#if smtp.configured}
    <p class="mt-1 text-xs text-green-700">✓ Password is currently set</p>
  {/if}
  <div class="mt-4 grid grid-cols-2 gap-4">
    <PlatformSettingsSmtpServer bind:smtpHost bind:smtpPort {smtp} {data} />
    <PlatformSettingsSmtpAccount
      bind:smtpUser
      bind:smtpFrom
      bind:smtpPassword
      {smtp}
      {fieldErrors}
      {data}
    /><InjectionPoint name="platform.settings.smtp" {data} />
  </div>
</section>
