<script lang="ts">
  import type { EffectiveSmtpSettings } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the SMTP host and port fields as one replaceable region (editing state is owned by
  // the settings form; the placeholders show the effective values).
  let {
    smtpHost = $bindable(),
    smtpPort = $bindable(),
    smtp,
    data,
  }: {
    smtpHost: string
    smtpPort: string
    smtp: EffectiveSmtpSettings
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.smtp-server -->
<RegionFragment>
  <label class="flex flex-col text-sm text-gray-700">
    Host
    <input
      type="text"
      bind:value={smtpHost}
      placeholder={smtp.host ?? ''}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="smtp-host-help"
    />
  </label>
  <FormHelpText id="smtp-host-help" kind="text" />
  <label class="flex flex-col text-sm text-gray-700">
    Port
    <input
      type="number"
      bind:value={smtpPort}
      placeholder={smtp.port?.toString() ?? ''}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="smtp-port-help"
    />
  </label>
  <FormHelpText id="smtp-port-help" kind="date" /><InjectionPoint
    name="platform.settings.smtp-server"
    {data}
  />
</RegionFragment>
