<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { getCurrentUser } from '$lib/api/auth.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { acceptInvitation, peekInvitation, type InvitationPeek } from '$lib/api/invitations.js'

  let status = $state<'loading' | 'invalid' | 'error'>('loading')
  let invalidReason = $state('')

  async function run() {
    const token = page.url.searchParams.get('token')
    if (!token) {
      status = 'invalid'
      invalidReason = 'This invitation link is missing a token.'
      return
    }

    let peek: InvitationPeek
    try {
      peek = await peekInvitation(fetch, token)
    } catch (error) {
      status = 'invalid'
      invalidReason =
        error instanceof ApiClientError
          ? 'This invitation link is no longer valid.'
          : 'Something went wrong loading this invitation.'
      return
    }

    if (!peek.accountExists) {
      const params = new URLSearchParams({ invitationToken: token, email: peek.email })
      // Dynamic query string, not a literal resolve() can type-check at compile time.
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(`/register?${params.toString()}`)
      return
    }

    try {
      await getCurrentUser(fetch)
    } catch {
      const next = `/invitations/accept?token=${encodeURIComponent(token)}`
      // eslint-disable-next-line svelte/no-navigation-without-resolve
      await goto(`/login?next=${encodeURIComponent(next)}`)
      return
    }

    try {
      const result = await acceptInvitation(fetch, token)
      await goto(resolve(`/projects/${result.projectId}`))
    } catch {
      status = 'error'
    }
  }

  onMount(() => {
    void run()
  })
</script>

<svelte:head>
  <title>Accept invitation | Project Vault</title>
</svelte:head>

<div class="space-y-6">
  {#if status === 'loading'}
    <p class="text-slate-600">Checking your invitation...</p>
  {:else if status === 'invalid'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Invitation not available</h1>
      <p class="text-slate-600">{invalidReason}</p>
    </div>
  {:else if status === 'error'}
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Something went wrong</h1>
      <p class="text-slate-600">We couldn't accept this invitation. Please try again.</p>
    </div>
  {/if}
</div>
