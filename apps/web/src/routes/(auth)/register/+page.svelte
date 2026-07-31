<script lang="ts">
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

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>
