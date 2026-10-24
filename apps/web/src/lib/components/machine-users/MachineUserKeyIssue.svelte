<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { PointData } from './machine-user-detail.js'
  import type { MachineUserKeys } from './machine-user-keys.svelte.js'

  // Story 69.14: the "Issue a new API key" form as one replaceable region, shown to managers of an
  // active machine user. The typed name and the pending and error state live in the keys controller.
  let { keys, show, data }: { keys: MachineUserKeys; show: boolean; data?: PointData } = $props()
</script>

<!-- @region project.machine-users-detail.key-issue -->
<RegionFragment>
  {#if show}
    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Issue a new API key</h2>
      <form
        class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
        onsubmit={(event) => {
          event.preventDefault()
          void keys.issue()
        }}
      >
        <div class="flex-1 space-y-1">
          <label class="block text-sm font-medium text-slate-800" for="issue-key-name">
            Key name
          </label>
          <input
            id="issue-key-name"
            class="w-full rounded-xl border border-slate-300 px-3 py-2"
            type="text"
            bind:value={keys.issueName}
            required
            aria-describedby="issue-key-name-help"
          />
          <FormHelpText id="issue-key-name-help" kind="text" />
        </div>
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-60"
          type="submit"
          disabled={keys.issuing}
        >
          {keys.issuing ? 'Issuing…' : 'Issue key'}
        </button>
      </form>
      {#if keys.issueError}
        <p class="mt-2 text-sm text-red-700" role="alert">{keys.issueError}</p>
      {/if}<InjectionPoint name="project.machine-users-detail.key-issue" {data} />
    </section>
  {/if}
</RegionFragment>
