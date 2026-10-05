<script lang="ts">
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'

  // Story 69.4: the fields and submit button of the invite form. The page keeps the `<form>`
  // element (and its submit handler and the open/closed state) and renders its
  // `project.members.invite` point after this, inside the form.
  let {
    email = $bindable(),
    role = $bindable(),
    errorMessage,
    isSubmitting,
  }: {
    email: string
    role: 'admin' | 'member' | 'viewer'
    errorMessage: string | null
    isSubmitting: boolean
  } = $props()
</script>

<div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="invite-email">Email</label>
    <input
      id="invite-email"
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      type="email"
      bind:value={email}
      required
      aria-describedby="invite-email-help"
    />
    <FormHelpText id="invite-email-help" kind="text" />
  </div>
  <div class="space-y-2">
    <label class="block font-medium text-slate-900" for="invite-role">Role</label>
    <select
      id="invite-role"
      class="w-full rounded-xl border border-slate-300 px-3 py-2"
      bind:value={role}
      aria-describedby="invite-role-help"
    >
      <option value="admin">Admin</option>
      <option value="member">Member</option>
      <option value="viewer">Viewer</option>
    </select>
    <FormHelpText id="invite-role-help" kind="select" />
  </div>
</div>
<MfaAwareErrorAlert
  message={errorMessage}
  class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
/>
<button
  class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
  type="submit"
  disabled={isSubmitting}
>
  {isSubmitting ? 'Sending...' : 'Send invite'}
</button>
