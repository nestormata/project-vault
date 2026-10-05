<script lang="ts">
  import RegisterHeading from '$lib/components/auth/RegisterHeading.svelte'
  import RegisterLoginLink from '$lib/components/auth/RegisterLoginLink.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()

  import { page } from '$app/state'
  import { m } from '$lib/paraglide/messages.js'
  import RegisterForm from '$lib/components/auth/RegisterForm.svelte'

  let invitationToken = $derived(page.url.searchParams.get('invitationToken') ?? undefined)
  let prefillEmail = $derived(page.url.searchParams.get('email') ?? '')
  let localeRevision = $state(0)
  let pageTitle = $derived(
    localeRevision === 0 ? m.auth_register_page_title() : m.auth_register_page_title()
  )

  function handleLocaleChange() {
    localeRevision += 1
  }
</script>

<InjectionPoint name="auth.register.before" data={data?.__inject} />
<InjectionPoint name="auth.register.header.actions" data={data?.__inject} />
<div class="space-y-6">
  {#key localeRevision}
    <!-- @region auth.register.heading -->
    <RegisterHeading {invitationToken}>
      <InjectionPoint name="auth.register.heading" data={data?.__inject} />
    </RegisterHeading>
    <!-- @region auth.register.login-link -->
    <RegisterLoginLink>
      <InjectionPoint name="auth.register.login-link" data={data?.__inject} />
    </RegisterLoginLink>{/key}
  <RegisterForm {invitationToken} {prefillEmail} onLocaleChange={handleLocaleChange} />
</div>
<InjectionPoint name="auth.register.after" data={data?.__inject} />

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>
