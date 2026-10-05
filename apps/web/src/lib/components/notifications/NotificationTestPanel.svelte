<script lang="ts">
  import { enhance } from '$app/forms'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import type { NotificationTestResult } from '$lib/api/notifications.js'

  // Story 69.4: the body of the "Send Test Notification" card (the send button or MFA hint and the
  // result lines). The page keeps the card element and its heading (inside its own admin gate) and
  // renders its `settings.notifications.test` point after this.
  // `testResult` and `error` come from the page's action result; `error` is the shared form error
  // (it also shows an `updatePreference` failure here: pinned by the phase 5 oracle, Story 69.4 Q6).
  let {
    canSendTest,
    testResult,
    error,
  }: {
    canSendTest: boolean
    testResult: NotificationTestResult | undefined
    error: string | undefined
  } = $props()

  const CHANNEL_LABELS: Record<string, string> = {
    delivered: 'Delivered',
    failed: 'Failed',
    not_configured: 'Not configured',
  }

  function resultClass(result: NotificationTestResult['email']): string {
    if (result === 'delivered') return 'text-green-700'
    if (result === 'not_configured') return 'text-gray-500'
    return 'text-red-700'
  }
</script>

<div class="px-6 py-4">
  {#if canSendTest}
    <form method="POST" action="?/sendTest" use:enhance>
      <button
        type="submit"
        class="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
      >
        Send test notification
      </button>
    </form>
  {:else}
    <MfaAwareErrorAlert
      message="Enroll in MFA to unlock the test notification action for your admin account."
      class="text-sm text-gray-500"
    />
  {/if}

  {#if testResult}
    <ul class="mt-4 space-y-1 text-sm">
      <li>
        Email:
        <span class={resultClass(testResult.email)}>
          {CHANNEL_LABELS[testResult.email]}
        </span>
      </li>
      <li>
        Slack:
        <span class={resultClass(testResult.slack)}>
          {CHANNEL_LABELS[testResult.slack]}
        </span>
      </li>
    </ul>
  {/if}

  {#if error}
    <p class="mt-4 text-sm text-amber-700">{error}</p>
  {/if}
</div>
