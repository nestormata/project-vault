<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import { ApiClientError, isMfaRequiredError } from '$lib/api/client.js'
  import { invalidateAll } from '$app/navigation'
  import { triggerThemeReload } from '$lib/api/themes.js'
  import { resolve } from '$app/paths'

  // Story 69.12: the "Reload themes" card of the themes admin sections. It owns the whole reload
  // flow (busy flag, outcome message, error and the MFA notice); the page reloads its theme list
  // through `invalidateAll`.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()

  async function handleReload() {
    if (reloading) return
    reloading = true
    reloadMessage = null
    reloadError = null
    try {
      const result = await triggerThemeReload(fetch)
      const loadedCount = result.loaded.length
      if (result.failed.length === 0) {
        reloadMessage = `Reloaded ${loadedCount} theme(s).`
      } else {
        const failedList = result.failed.map((f) => `${f.file} — ${f.reason}`).join('; ')
        reloadMessage = `Reloaded ${loadedCount} theme(s). ${result.failed.length} failed: ${failedList}.`
      }
      // AC-2/AC-3: refresh the theme list below so any newly loaded theme appears without a
      // manual page refresh.
      await invalidateAll()
    } catch (err) {
      if (isMfaRequiredError(err)) {
        // AC-4: replace the button with an inline notice rather than a generic error banner.
        reloadMfaRequired = true
      } else if (err instanceof ApiClientError && err.status === 429) {
        // AC-5: do not retry automatically; tell the admin to wait.
        reloadError = 'Too many reload attempts — wait a moment and try again.'
      } else if (err instanceof ApiClientError && err.status === 503) {
        // AC-7: fail-closed audit write — the UI must not claim success.
        reloadError = 'Reload failed — please try again.'
      } else if (err instanceof ApiClientError && err.status === 403) {
        // AC-8: defense-in-depth for a stale session whose role was downgraded after page load.
        reloadError = 'You do not have permission to reload themes.'
      } else {
        reloadError = 'Reload failed — please try again.'
      }
    } finally {
      reloading = false
    }
  }
  // Story 16.3 — "Reload themes" admin/owner section. The button is shown to every admin/owner
  // (AC-4: there is no side-effect-free way to know MFA-enrollment status ahead of
  // time for this endpoint), and MFA-required state is detected reactively from the click's own
  // 403 mfa_required response, not a load-time precheck.
  let reloading = $state(false)
  let reloadMfaRequired = $state(false)
  let reloadError = $state<string | null>(null)
  let reloadMessage = $state<string | null>(null)
</script>

<!-- @region settings.themes.reload -->
<RegionFragment>
  <div class="mt-8 rounded-lg border border-gray-200 bg-white px-6 py-4">
    <h2 class="text-lg font-semibold text-gray-900">Reload themes</h2>
    <p class="mt-1 text-sm text-gray-500">
      Re-scan the themes directory and compile any newly installed custom theme files.
    </p>

    {#if reloadMessage}
      <p
        class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
        role="status"
      >
        {reloadMessage}
      </p>
    {/if}
    {#if reloadError}
      <p
        class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {reloadError}
      </p>
    {/if}

    {#if reloadMfaRequired}
      <p class="mt-4 text-sm text-amber-700">
        MFA required to reload themes.
        <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
      </p>
    {:else}
      <button
        type="button"
        class="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        disabled={reloading}
        onclick={() => void handleReload()}
      >
        {reloading ? 'Reloading…' : 'Reload themes'}
      </button>
    {/if}<InjectionPoint name="settings.themes.reload" {data} />
  </div>
</RegionFragment>
