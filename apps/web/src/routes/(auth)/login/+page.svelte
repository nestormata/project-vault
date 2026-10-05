<script lang="ts">
  import LoginHeading from '$lib/components/auth/LoginHeading.svelte'
  import LoginReasonNotice from '$lib/components/auth/LoginReasonNotice.svelte'
  import LoginAccountLinks from '$lib/components/auth/LoginAccountLinks.svelte'
  import LoginFormSection from '$lib/components/auth/LoginFormSection.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import { page } from '$app/state'

  import { m } from '$lib/paraglide/messages.js'

  // Only allow same-origin relative paths — a bare "/x" is safe, "//evil.com" or an absolute
  // URL is not (browsers treat "//" as protocol-relative, i.e. an external redirect).
  function safeNextPath(raw: string | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
    return raw
  }

  // Story 23.2 AC-13: `data.nativeLoginEnabled` defaults to `true` when the prop itself is
  // absent (existing tests that render this page without SvelteKit's load — byte-identical to
  // today, AC-16) — `null` (the load's own cold-start-failure signal) is preserved as-is.
  let {
    data = { nativeLoginEnabled: true },
  }: {
    data?: { nativeLoginEnabled: boolean | null; __inject?: App.PageData['__inject'] }
  } = $props()

  let localeRevision = $state(0)
  let nextPath = $derived(safeNextPath(page.url.searchParams.get('next')))
  let pageTitle = $derived(
    localeRevision === 0 ? m.auth_login_page_title() : m.auth_login_page_title()
  )

  function handleLocaleChange() {
    localeRevision += 1
  }
</script>

<InjectionPoint name="auth.login.before" data={data?.__inject} />
<InjectionPoint name="auth.login.header.actions" data={data?.__inject} />
<div class="space-y-6">
  {#key localeRevision}
    <!-- @region auth.login.heading -->
    <LoginHeading>
      <InjectionPoint name="auth.login.heading" data={data?.__inject} />
    </LoginHeading>
    <!-- @region auth.login.reason -->
    <LoginReasonNotice>
      <InjectionPoint name="auth.login.reason" data={data?.__inject} />
    </LoginReasonNotice>
    <!-- @region auth.login.links -->
    <LoginAccountLinks nativeLoginEnabled={data.nativeLoginEnabled}>
      <InjectionPoint name="auth.login.links" data={data?.__inject} />
    </LoginAccountLinks>{/key}
  <!-- @region auth.login.form -->
  <LoginFormSection nativeLoginEnabled={data.nativeLoginEnabled} {nextPath} {handleLocaleChange}>
    <InjectionPoint name="auth.login.form" data={data?.__inject} />
  </LoginFormSection>
</div>
<InjectionPoint name="auth.login.after" data={data?.__inject} />

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>
