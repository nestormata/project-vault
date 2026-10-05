<script lang="ts">
  import type { Snippet } from 'svelte'
  import ProjectInviteForm from './ProjectInviteForm.svelte'

  // Story 69.5: the `<form>` of the invite region and its submit handler. The page keeps the
  // open/closed state, the submit action and the `project.members.invite` point (passed as
  // `children`, rendered inside the form after the fields).
  let {
    email = $bindable(),
    role = $bindable(),
    errorMessage,
    isSubmitting,
    onsubmit,
    children,
  }: {
    email: string
    role: 'admin' | 'member' | 'viewer'
    errorMessage: string | null
    isSubmitting: boolean
    onsubmit: () => void
    children?: Snippet
  } = $props()
</script>

<form
  class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
  onsubmit={(event) => {
    event.preventDefault()
    void onsubmit()
  }}
>
  <ProjectInviteForm bind:email bind:role {errorMessage} {isSubmitting} />{@render children?.()}
</form>
