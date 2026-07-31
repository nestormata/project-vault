<script lang="ts">
  import { setLocale } from '$lib/paraglide/runtime.js'
  import { m } from '$lib/paraglide/messages.js'
  import {
    SUPPORTED_LOCALE_DISPLAY_NAMES,
    SUPPORTED_LOCALES,
    type SupportedLocale,
  } from '@project-vault/shared'

  let latestRequest = 0
  let latestLocale = $state<SupportedLocale | null>(null)

  async function selectLocale(locale: SupportedLocale) {
    const request = ++latestRequest
    latestLocale = locale
    await setLocale(locale, { reload: false })

    // setLocale is normally synchronous, but keeping the latest request as the source of truth
    // prevents a slower custom locale strategy from allowing an earlier click to win the race.
    if (request !== latestRequest && latestLocale) {
      await setLocale(latestLocale, { reload: false })
    }
  }
</script>

<div
  class="flex flex-wrap items-center gap-2"
  role="group"
  aria-label={m.settings_nav_language_title()}
>
  <span class="text-sm font-medium text-slate-700">{m.settings_nav_language_title()}</span>
  {#each SUPPORTED_LOCALES as locale (locale)}
    <button
      class="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
      type="button"
      aria-label={SUPPORTED_LOCALE_DISPLAY_NAMES[locale]}
      onclick={() => void selectLocale(locale)}
    >
      {SUPPORTED_LOCALE_DISPLAY_NAMES[locale]}
    </button>
  {/each}
</div>
