<script lang="ts">
  import { ApiClientError } from '$lib/api/client.js'
  import { updateOrgDefaultLocale } from '$lib/api/organization-settings.js'
  import {
    SUPPORTED_LOCALES,
    SUPPORTED_LOCALE_DISPLAY_NAMES,
    type SupportedLocale,
  } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.10: the default language for new users card. Its state is used by this card only (moved verbatim from the panel).
  let {
    orgId,
    data,
  }: {
    orgId: string
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // Story 15.2 AC 1 — org default display-language for newly invited/self-signed-up users. Same
  // "set a new value, no GET readback" shape as the two dormancy-threshold controls on this page (this
  // page's own established, deliberate precedent): the API only
  // ships a PATCH for this setting, so the org's current default cannot be displayed here.
  let defaultLocaleChoice = $state<SupportedLocale | ''>('')
  let defaultLocaleSaving = $state(false)
  let defaultLocaleSavedTo = $state<string | null>(null)
  let defaultLocaleError = $state<string | null>(null)
  async function onSaveDefaultLocale() {
    if (defaultLocaleSaving || defaultLocaleChoice === '') return
    defaultLocaleSaving = true
    defaultLocaleError = null
    defaultLocaleSavedTo = null
    try {
      const result = await updateOrgDefaultLocale(fetch, orgId, defaultLocaleChoice)
      defaultLocaleSavedTo = result.defaultLocale
    } catch (error) {
      defaultLocaleError =
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to update default language.')
          : 'Failed to update default language.'
    } finally {
      defaultLocaleSaving = false
    }
  }
</script>

<!-- @region settings.users.default-language -->
<div class="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Default language for new users</h2>
  <p class="mt-2 text-sm text-slate-600">
    The display language new invited or self-signed-up users start with on their first login. This
    does not change any existing user's own language — each person's individual choice (Settings
    &gt; Language) always wins going forward.
  </p>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <label class="sr-only" for="default-locale-select">Default language for new users</label>
    <select
      id="default-locale-select"
      class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
      bind:value={defaultLocaleChoice}
      aria-describedby="default-locale-help"
    >
      <option value="">Choose a new default…</option>
      {#each SUPPORTED_LOCALES as locale (locale)}
        <option value={locale}>{SUPPORTED_LOCALE_DISPLAY_NAMES[locale]}</option>
      {/each}
    </select>
    <FormHelpText id="default-locale-help" kind="select" />
    <button
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      type="button"
      disabled={defaultLocaleSaving || defaultLocaleChoice === ''}
      onclick={() => void onSaveDefaultLocale()}
    >
      {defaultLocaleSaving ? 'Saving…' : 'Save default language'}
    </button>
  </div>
  {#if defaultLocaleSavedTo !== null}
    <p class="mt-2 text-sm text-emerald-700">
      Default language updated to {SUPPORTED_LOCALE_DISPLAY_NAMES[
        defaultLocaleSavedTo as SupportedLocale
      ] ?? defaultLocaleSavedTo}.
    </p>
  {/if}
  {#if defaultLocaleError}
    <p class="mt-2 text-sm text-red-700" role="alert">{defaultLocaleError}</p>
  {/if}<InjectionPoint name="settings.users.default-language" {data} />
</div>
