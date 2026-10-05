<script lang="ts">
  import type { ThemesPageData } from '../../../routes/(app)/settings/themes/+page.server.js'
  import type { Snippet } from 'svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { ApiClientError, isMfaRequiredError } from '$lib/api/client.js'
  import { updateOrgDefaultTheme } from '$lib/api/organization-settings.js'
  import { invalidateAll } from '$app/navigation'
  import { triggerThemeReload } from '$lib/api/themes.js'
  import { resolve } from '$app/paths'

  let {
    canReload,
    themes,
    orgId,
    orgDefaultThemeName,
    children,
  }: {
    canReload: boolean
    themes: ThemesPageData['themes']
    orgId: ThemesPageData['orgId']
    orgDefaultThemeName: ThemesPageData['orgDefaultThemeName']
    children?: Snippet
  } = $props()

  async function selectOrgDefaultTheme(themeName: string | null) {
    if (orgDefaultSaving) return
    orgDefaultSaving = true
    orgDefaultMessage = null
    orgDefaultError = null
    try {
      const result = await updateOrgDefaultTheme(fetch, orgId, themeName)
      orgDefault = result.defaultThemeName
      orgDefaultMessage = 'Saved.'
    } catch (err) {
      // AC-1 edge — defensive: a stale client-side themes list could still submit a name the
      // server no longer recognizes (a reload ran elsewhere since this page loaded).
      if (err instanceof ApiClientError && err.status === 400) {
        orgDefaultError = 'That theme is no longer available — try reloading the page.'
      } else {
        orgDefaultError = 'Failed to save the organization default theme, try again.'
      }
    } finally {
      orgDefaultSaving = false
    }
  }
  // Story 16.4 Task 5.3 — "Default theme for this organization" admin/owner-only section.
  // Immediate-save-on-change (like this page's own personal-selection list above), not 16.3's
  // explicit-button pattern — this is a settings *change*, not a triggered *action*. Unlike the
  // personal-selection list, this section's `orgDefault` is pre-selected on load (Task 5.1's Dev
  // Notes: a GET already exists for a different reason, so, unlike locale/dormancy, there is no
  // reason to withhold the current value).
  let orgDefault = $derived(orgDefaultThemeName)
  let orgDefaultError = $state<string | null>(null)
  let orgDefaultMessage = $state<string | null>(null)
  let orgDefaultSaving = $state(false)
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
  let reloadMfaRequired = $state(false)
  let reloadError = $state<string | null>(null)
  let reloadMessage = $state<string | null>(null)
  // Story 16.3 — "Reload themes" admin/owner section. The button is shown to every admin/owner
  // (AC-4: there is no side-effect-free way to know MFA-enrollment status ahead of
  // time for this endpoint), and MFA-required state is detected reactively from the click's own
  // 403 mfa_required response, not a load-time precheck.
  let reloading = $state(false)
</script>

{@render children?.()}
{#if canReload}
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
    {/if}
  </div>

  <div class="mt-8 rounded-lg border border-gray-200 bg-white px-6 py-4">
    <h2 class="text-lg font-semibold text-gray-900">Default theme for this organization</h2>
    <p class="mt-1 text-sm text-gray-500">
      Members who haven't chosen their own theme, and the login screen for a resolvable email
      domain, will see this theme.
    </p>

    {#if orgDefaultMessage}
      <p
        class="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
        role="status"
      >
        {orgDefaultMessage}
      </p>
    {/if}
    {#if orgDefaultError}
      <p
        class="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        role="alert"
      >
        {orgDefaultError}
      </p>
    {/if}

    <select
      class="mt-4 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
      aria-label="Default theme for this organization"
      disabled={orgDefaultSaving}
      value={orgDefault ?? ''}
      aria-describedby="org-default-theme-help"
      onchange={(event) => {
        const value = event.currentTarget.value
        void selectOrgDefaultTheme(value === '' ? null : value)
      }}
    >
      <option value="">None (base theme)</option>
      {#each themes.filter((theme) => theme.name !== 'base') as theme (theme.name)}
        <option value={theme.name}>{theme.label}</option>
      {/each}
    </select>
    <FormHelpText id="org-default-theme-help" kind="select" />
  </div>
{/if}
