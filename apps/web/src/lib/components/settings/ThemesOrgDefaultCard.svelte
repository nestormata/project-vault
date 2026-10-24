<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { ApiClientError } from '$lib/api/client.js'
  import { updateOrgDefaultTheme } from '$lib/api/organization-settings.js'
  import type { ThemesPageData } from '../../../routes/(app)/settings/themes/+page.server.js'

  // Story 69.12: the "Default theme for this organization" card of the themes admin sections. It
  // owns the save flow (busy flag, outcome message, error and the selected value).
  let {
    themes,
    orgId,
    orgDefaultThemeName,
    data,
  }: {
    themes: ThemesPageData['themes']
    orgId: ThemesPageData['orgId']
    orgDefaultThemeName: ThemesPageData['orgDefaultThemeName']
    data?: Record<string, readonly unknown[]> | undefined
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
</script>

<!-- @region settings.themes.org-default -->
<RegionFragment>
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
    <FormHelpText id="org-default-theme-help" kind="select" /><InjectionPoint
      name="settings.themes.org-default"
      {data}
    />
  </div>
</RegionFragment>
