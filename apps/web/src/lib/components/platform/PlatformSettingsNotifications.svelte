<script lang="ts">
  import type { EffectiveNotificationSettings } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the Notifications card (default Slack webhook) of the system settings as one
  // replaceable region. The settings form owns the editing state.
  let {
    defaultSlackWebhook = $bindable(),
    notifications,
    data,
  }: {
    defaultSlackWebhook: string
    notifications: EffectiveNotificationSettings
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.notifications -->
<section class="rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-gray-900">Notifications</h2>
  <label class="mt-4 flex flex-col text-sm text-gray-700">
    Default Slack webhook URL
    <input
      type="url"
      bind:value={defaultSlackWebhook}
      placeholder={notifications.defaultSlackWebhook ?? 'https://hooks.slack.com/…'}
      class="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
      aria-describedby="slack-webhook-help"
    />
  </label>
  <FormHelpText id="slack-webhook-help" kind="text" /><InjectionPoint
    name="platform.settings.notifications"
    {data}
  />
</section>
