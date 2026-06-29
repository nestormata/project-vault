<script lang="ts">
  import { resolve } from '$app/paths'
  import { completeOnboarding } from '$lib/api/onboarding.js'
  import { ApiClientError } from '$lib/api/client.js'
  import { onboardingCopy } from './onboarding-logic.js'

  let {
    projectId,
    importRouteLive = false,
    oncompleted,
    headingId,
  }: {
    projectId: string | null
    importRouteLive?: boolean
    oncompleted: () => void
    headingId: string
  } = $props()

  let finishing = $state(false)
  let errorMessage = $state<string | null>(null)

  async function finish() {
    if (finishing) return
    finishing = true
    errorMessage = null
    try {
      await completeOnboarding(fetch)
      oncompleted()
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        oncompleted()
        return
      }
      errorMessage = 'Something went wrong — please try again'
      finishing = false
    }
  }
</script>

<section>
  <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">You're set up!</h2>
  <p class="mt-2 text-slate-700">Here's what you can do next:</p>
  <ul class="mt-4 list-disc space-y-2 pl-5 text-slate-700">
    <li>
      {#if importRouteLive}
        <a class="font-medium text-slate-950 underline" href={resolve('/credentials/import')}>
          Import credentials in bulk
        </a>
      {:else}
        <span class="cursor-not-allowed text-slate-500" aria-disabled="true" title="Coming soon">
          Import credentials in bulk (coming soon)
        </span>
      {/if}
    </li>
    <li>
      {#if projectId}
        <a class="font-medium text-slate-950 underline" href={resolve('/credentials')}>
          Add more credentials manually
        </a>
      {:else}
        <span class="text-slate-600">Add more credentials manually from the credentials page</span>
      {/if}
    </li>
    <li>
      <a class="font-medium text-slate-950 underline" href={resolve('/settings')}>
        Invite your team
      </a>
    </li>
    <li>
      <a class="font-medium text-slate-950 underline" href={resolve('/dashboard')}>
        Explore the dashboard
      </a>
    </li>
  </ul>
  <p class="mt-4 text-sm text-slate-500">{onboardingCopy.globalSearchMention}</p>
  {#if errorMessage}
    <p class="mt-4 text-sm text-red-700" role="alert">{errorMessage}</p>
  {/if}
  <button
    class="mt-6 min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
    type="button"
    disabled={finishing}
    onclick={() => void finish()}
  >
    {finishing ? 'Finishing…' : 'Go to Dashboard'}
  </button>
</section>
