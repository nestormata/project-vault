<script lang="ts">
  import type { EffectiveSmtpSettings } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the SMTP username, from address and password fields as one replaceable region.
  let {
    smtpUser = $bindable(),
    smtpFrom = $bindable(),
    smtpPassword = $bindable(),
    smtp,
    fieldErrors,
    data,
  }: {
    smtpUser: string
    smtpFrom: string
    smtpPassword: string
    smtp: EffectiveSmtpSettings
    fieldErrors: Record<string, string>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.smtp-account -->
<RegionFragment>
  <label class="flex flex-col text-sm text-gray-700">
    Username
    <input
      type="text"
      bind:value={smtpUser}
      placeholder={smtp.user ?? ''}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="smtp-user-help"
    />
  </label>
  <FormHelpText id="smtp-user-help" kind="text" />
  <label class="flex flex-col text-sm text-gray-700">
    From address
    <input
      type="email"
      bind:value={smtpFrom}
      placeholder={smtp.from ?? ''}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="smtp-from-help"
    />
    {#if fieldErrors['smtp.from']}
      <span class="text-xs text-red-600">{fieldErrors['smtp.from']}</span>
    {/if}
  </label>
  <FormHelpText id="smtp-from-help" kind="text" />
  <label class="col-span-2 flex flex-col text-sm text-gray-700">
    Password
    <input
      type="password"
      bind:value={smtpPassword}
      placeholder="Leave blank to keep the current password"
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="smtp-password-help"
    />
  </label>
  <FormHelpText id="smtp-password-help" kind="secret" /><InjectionPoint
    name="platform.settings.smtp-account"
    {data}
  />
</RegionFragment>
