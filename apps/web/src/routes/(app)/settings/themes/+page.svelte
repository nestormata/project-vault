<script lang="ts">
  import ThemesHeader from '$lib/components/settings/ThemesHeader.svelte'
  import ThemesSelectionError from '$lib/components/settings/ThemesSelectionError.svelte'
  import ThemesList from '$lib/components/settings/ThemesList.svelte'
  import ThemesAdminSections from '$lib/components/settings/ThemesAdminSections.svelte'
  import NavLinkRegion from '$lib/components/shell/NavLinkRegion.svelte'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { patchThemeSelection } from '$lib/api/themes.js'

  import { setAppliedTheme } from '$lib/state/theme.svelte.js'
  import type { ThemesPageData } from './+page.server.js'

  const { data }: { data: ThemesPageData } = $props()

  // Story 68.1 AC-3: writable $derived — both selections save immediately on change, so a new
  // load (invalidateAll after a reload, or navigation) resets them from the server's values while
  // a successful save below still updates them locally.
  let selected = $derived(data.selected)
  let saving = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)

  // AC-3 second edge case: a stored selection that no longer appears in the currently-compiled
  // set is shown as its own distinct, disabled "currently unavailable" option — never silently
  // defaulted to "Default" in this radio group, so the user isn't confused about what's actually
  // stored vs. what's currently applied (that distinction is the (app) layout's orphaned-theme
  // notice, a separate concern from this page).
  const availableNames = $derived(data.themes.map((theme) => theme.name))
  const orphanedSelection = $derived(
    selected !== null && !availableNames.includes(selected) ? selected : null
  )

  async function selectTheme(themeName: string | null) {
    if (saving) return
    saving = themeName ?? 'base'
    errorMessage = null
    try {
      const result = await patchThemeSelection(fetch, themeName)
      // AC-2: pessimistic — only apply the new theme app-wide after the server confirms the
      // save, never optimistically on click.
      selected = result.themeName
      setAppliedTheme(result.themeName)
    } catch {
      errorMessage = 'Failed to save your theme selection, try again.'
    } finally {
      saving = null
    }
  }
</script>

<svelte:head>
  <title>Themes | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.themes.before" data={data?.__inject} />
<InjectionPoint name="settings.themes.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region settings.themes.back -->
  <NavLinkRegion
    surface="back"
    node="back.settings.themes"
    class="text-sm text-indigo-600 hover:text-indigo-800"
  >
    <InjectionPoint name="settings.themes.back" data={data?.__inject} />
  </NavLinkRegion>
  <!-- @region settings.themes.header -->
  <ThemesHeader>
    <InjectionPoint name="settings.themes.header" data={data?.__inject} />
  </ThemesHeader>

  <!-- @region settings.themes.selection-error -->
  <ThemesSelectionError {errorMessage}>
    <InjectionPoint name="settings.themes.selection-error" data={data?.__inject} />
  </ThemesSelectionError>

  <!-- @region settings.themes.list -->
  <ThemesList
    loadError={data.errorMessage}
    themes={data.themes}
    {selected}
    {saving}
    {orphanedSelection}
    {selectTheme}
  >
    <InjectionPoint name="settings.themes.list" data={data?.__inject} />
  </ThemesList>

  <!-- @region settings.themes.admin -->
  <ThemesAdminSections
    canReload={data.canReload}
    themes={data.themes}
    orgId={data.orgId}
    orgDefaultThemeName={data.orgDefaultThemeName}
  >
    <InjectionPoint name="settings.themes.admin" data={data?.__inject} />
  </ThemesAdminSections>
</div>
<InjectionPoint name="settings.themes.after" data={data?.__inject} />
