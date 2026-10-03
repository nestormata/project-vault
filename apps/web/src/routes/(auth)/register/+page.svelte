<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  let { data } = $props()
  import { resolve } from '$app/paths'
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
    <div class="space-y-2">
      <h1 class="text-3xl font-bold">{m.auth_register_page_heading()}</h1>
      <p class="text-slate-600">
        {invitationToken
          ? m.auth_register_invitation_description()
          : m.auth_register_organization_description()}
      </p>
    </div>
    <p class="text-sm text-slate-600">
      {m.auth_register_existing_account_prompt()}
      <a class="font-medium text-brand-600 underline" href={resolve('/login')}
        >{m.auth_login_sign_in()}</a
      >
    </p>
  {/key}
  <RegisterForm {invitationToken} {prefillEmail} onLocaleChange={handleLocaleChange} />
</div>
<InjectionPoint name="auth.register.after" data={data?.__inject} />

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>
