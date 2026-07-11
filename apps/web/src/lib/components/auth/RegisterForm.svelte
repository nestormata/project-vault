<script lang="ts">
  import { goto } from '$app/navigation'
  import { register } from '$lib/api/auth.js'
  import { buildRegisterRequest, clearRegisterFields, getPostRegisterPath } from './form-model.js'

  let { invitationToken, prefillEmail = '' }: { invitationToken?: string; prefillEmail?: string } =
    $props()

  let email = $state(prefillEmail)
  let password = $state('')
  let orgName = $state('')
  let errorMessage = $state(null)

  function clearFields() {
    const cleared = clearRegisterFields({ email, password, orgName })
    email = invitationToken ? prefillEmail : cleared.email
    password = cleared.password
    orgName = cleared.orgName
  }

  async function submitForm() {
    errorMessage = null
    try {
      const result = await register(
        fetch,
        buildRegisterRequest({ email, password, orgName, invitationToken })
      )
      clearFields()
      // getPostRegisterPath() returns either a static route or a server-issued project id —
      // not a literal resolve() can type-check at compile time.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(getPostRegisterPath(result.invitedProject))
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Registration failed.'
      password = ''
    }
  }
</script>

<form
  class="space-y-5"
  onsubmit={(event) => {
    event.preventDefault()
    void submitForm()
  }}
>
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="register-email">Email</label>
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="register-email"
      type="email"
      bind:value={email}
      readonly={Boolean(invitationToken)}
      required
    />
  </div>
  {#if !invitationToken}
    <div class="space-y-2">
      <label class="block font-medium text-slate-900" for="register-org">Organization name</label>
      <input
        class="w-full rounded-xl border border-slate-300 px-3 py-2"
        id="register-org"
        type="text"
        bind:value={orgName}
        maxlength="128"
        required
      />
    </div>
  {/if}
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="register-password">Password</label>
    <input
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      id="register-password"
      type="password"
      autocomplete="new-password"
      bind:value={password}
      minlength="12"
      required
    />
    <p class="text-sm text-slate-600">Use at least 12 characters.</p>
  </div>
  {#if errorMessage}
    <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {errorMessage}
    </p>
  {/if}
  <button
    class="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
    type="submit">Create account</button
  >
</form>
