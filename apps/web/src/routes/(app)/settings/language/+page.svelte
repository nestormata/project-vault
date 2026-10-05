<script lang="ts">
  import LanguageHeader from '$lib/components/settings/LanguageHeader.svelte'
  import LanguageErrors from '$lib/components/settings/LanguageErrors.svelte'
  import LanguageOptions from '$lib/components/settings/LanguageOptions.svelte'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { SubmitFunction } from '@sveltejs/kit'
  import { setLocale } from '$lib/paraglide/runtime.js'
  import { m } from '$lib/paraglide/messages.js'
  import { localeToApplyFromActionResult } from './locale-settings-model.js'
  import type { ActionData, PageData } from './$types.js'

  const { data, form }: { data: PageData; form: ActionData } = $props()

  let saving = $state(false)
  let errorMessage = $state<string | null>(null)

  const handleSubmit: SubmitFunction = () => {
    saving = true
    errorMessage = null
    return async ({ result, update }) => {
      saving = false
      // Story 15.1 AC 9 — only switch the client-rendered locale AFTER the server confirms the
      // save (never optimistically before): a fail-closed audit rollback on the server must
      // never leave the client showing a locale that was never actually persisted. Re-reading the
      // server response (not the clicked value) as source of truth also naturally resolves the
      // AC 2 double-click race — the last PATCH to resolve determines the final UI state.
      const localeToApply = localeToApplyFromActionResult(result)
      if (localeToApply) {
        await setLocale(localeToApply, { reload: false })
      } else if (result.type === 'failure') {
        errorMessage = (result.data?.['error'] as string) ?? m.settings_language_save_error()
      }
      await update()
    }
  }
</script>

<svelte:head>
  <title>{m.settings_language_page_title()} | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.language.before" data={data?.__inject} />
<InjectionPoint name="settings.language.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <NavLink
    surface="back"
    node="back.settings.language"
    class="text-sm text-indigo-600 hover:text-indigo-800"
  />
  <!-- @region settings.language.header -->
  <LanguageHeader>
    <InjectionPoint name="settings.language.header" data={data?.__inject} />
  </LanguageHeader>

  <!-- @region settings.language.errors -->
  <LanguageErrors {errorMessage} {form}>
    <InjectionPoint name="settings.language.errors" data={data?.__inject} />
  </LanguageErrors>

  <!-- @region settings.language.options -->
  <LanguageOptions options={data.options} {saving} {handleSubmit}>
    <InjectionPoint name="settings.language.options" data={data?.__inject} />
  </LanguageOptions>
</div>
<InjectionPoint name="settings.language.after" data={data?.__inject} />
