<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import {
    generateStatusToken,
    revokeStatusToken,
    rotateStatusToken,
    testStatusToken,
    type StatusTokenTestResponse,
  } from '$lib/api/platform.js'
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PlatformSettingsStatusTokenActions from './PlatformSettingsStatusTokenActions.svelte'
  import PlatformSettingsStatusTokenReveal from './PlatformSettingsStatusTokenReveal.svelte'
  import PlatformSettingsStatusTokenState from './PlatformSettingsStatusTokenState.svelte'
  import PlatformSettingsStatusTokenTest from './PlatformSettingsStatusTokenTest.svelte'

  // Story 69.10: the monitoring bearer-token card (Story 1.19 AC-5/AC-6) as one replaceable region.
  // Everything display-once (the revealed token) lives in this component's local state, moved
  // verbatim from the content component; the page's load only seeds `configured`, the dates and
  // the load-failure flag.
  let {
    configured,
    createdAt,
    lastUsedAt,
    loadFailed,
    data,
  }: {
    configured: boolean
    createdAt: string | undefined
    lastUsedAt: string | undefined
    loadFailed: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 68.1 AC-3: writable $derived — a new load replaces these, while the generate/rotate/
  // revoke handlers below still update them locally.
  let statusTokenConfigured = $derived(configured)
  let statusTokenCreatedAt = $derived(createdAt)
  let statusTokenLastUsedAt = $derived(lastUsedAt)
  // Adversarial review fix: distinct from "not configured" — a load failure (network/5xx) must
  // never silently render as if the token simply doesn't exist yet.
  const statusTokenLoadFailed = $derived(loadFailed)
  // Secure-display-once: the plaintext only ever lives in this ephemeral, component-local state
  // — never re-fetchable, never part of `data` (mirrors machine-users' revealedKey pattern).
  let revealedStatusToken = $state<string | null>(null)
  let statusTokenBusy = $state(false)
  let statusTokenError = $state<string | null>(null)
  let statusTokenTestResult = $state<StatusTokenTestResponse | null>(null)
  let statusTokenTestBusy = $state(false)
  let statusTokenCopied = $state(false)
  let statusTokenCopyFailed = $state(false)
  async function copyStatusToken(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      statusTokenCopied = true
      statusTokenCopyFailed = false
    } catch {
      // Clipboard may be unavailable in some contexts (e.g. insecure origin, denied
      // permission) — surface it so the operator doesn't assume the copy succeeded and
      // navigate away from this one-time reveal without the token.
      statusTokenCopyFailed = true
    }
  }
  async function onGenerateOrRotateStatusToken() {
    if (statusTokenBusy) return
    statusTokenBusy = true
    statusTokenError = null
    statusTokenCopied = false
    statusTokenCopyFailed = false
    // Adversarial review fix: clear any previously revealed plaintext up front, before the
    // result of this request is known — otherwise a failed rotate leaves a stale (possibly
    // already-invalidated) plaintext token displayed next to the error, which is misleading.
    revealedStatusToken = null
    try {
      const result = statusTokenConfigured
        ? await rotateStatusToken(fetch)
        : await generateStatusToken(fetch)
      revealedStatusToken = result.token
      statusTokenConfigured = true
      statusTokenCreatedAt = result.createdAt
      statusTokenLastUsedAt = undefined
      statusTokenTestResult = null
    } catch (err) {
      statusTokenError =
        err instanceof ApiClientError
          ? (err.message ?? m.status_token_generate_or_rotate_error_default())
          : m.status_token_generate_or_rotate_error_default()
    } finally {
      statusTokenBusy = false
    }
  }
  async function onRevokeStatusToken() {
    if (statusTokenBusy) return
    statusTokenBusy = true
    statusTokenError = null
    try {
      await revokeStatusToken(fetch)
      statusTokenConfigured = false
      statusTokenCreatedAt = undefined
      statusTokenLastUsedAt = undefined
      revealedStatusToken = null
      statusTokenTestResult = null
    } catch (err) {
      statusTokenError =
        err instanceof ApiClientError
          ? (err.message ?? m.status_token_revoke_error_default())
          : m.status_token_revoke_error_default()
    } finally {
      statusTokenBusy = false
    }
  }
  async function onTestStatusToken() {
    if (statusTokenTestBusy) return
    statusTokenTestBusy = true
    statusTokenError = null
    try {
      statusTokenTestResult = await testStatusToken(fetch)
    } catch (err) {
      statusTokenError =
        err instanceof ApiClientError
          ? (err.message ?? m.status_token_test_error_default())
          : m.status_token_test_error_default()
    } finally {
      statusTokenTestBusy = false
    }
  }
</script>

<!-- @region platform.settings.status-token -->
<section class="mt-8 rounded-xl border border-gray-200 bg-white p-6">
  <h2 class="text-lg font-semibold text-gray-900">{m.status_token_section_heading()}</h2>
  <p id="status-token-help" class="mt-1 text-sm text-slate-600">
    {m.form_help_status_token()}
  </p>

  {#if statusTokenLoadFailed}
    <p
      class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      role="alert"
    >
      {m.status_token_load_failed()}
    </p>
  {/if}

  {#if statusTokenError}
    <p
      class="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      {statusTokenError}
    </p>
  {/if}

  {#if revealedStatusToken}
    <PlatformSettingsStatusTokenReveal
      token={revealedStatusToken}
      copied={statusTokenCopied}
      copyFailed={statusTokenCopyFailed}
      onCopy={copyStatusToken}
      {data}
    />
  {/if}

  <PlatformSettingsStatusTokenState
    configured={statusTokenConfigured}
    createdAt={statusTokenCreatedAt}
    lastUsedAt={statusTokenLastUsedAt}
    {data}
  />

  <PlatformSettingsStatusTokenActions
    configured={statusTokenConfigured}
    busy={statusTokenBusy}
    testBusy={statusTokenTestBusy}
    onGenerateOrRotate={onGenerateOrRotateStatusToken}
    onRevoke={onRevokeStatusToken}
    onTest={onTestStatusToken}
    {data}
  />

  {#if statusTokenTestResult}
    <PlatformSettingsStatusTokenTest result={statusTokenTestResult} {data} />
  {/if}<InjectionPoint name="platform.settings.status-token" {data} />
</section>
