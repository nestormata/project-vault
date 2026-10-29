<!--
  @pv-stable: takes no props (Story 72.6).
  The PV-owned host of the keyboard shortcuts dialog: the shared `Dialog` listing the shortcuts the
  app answers to. Mounted once in the (app) layout; the account menu's `account.shortcuts` action
  opens it through `$lib/state/shortcuts.svelte.ts`. Renders only the dialog element (closed until
  asked).
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { closeShortcuts, isShortcutsOpen } from '$lib/state/shortcuts.svelte.js'
  import Dialog from '$lib/components/ui/Dialog.svelte'

  // Writable $derived: follows the shared state, and the dialog's own close writes locally until
  // `onclose` clears the shared state.
  let open = $derived(isShortcutsOpen())

  const rows = $derived([
    { keys: ['Ctrl K', '⌘ K'], text: m.shortcuts_open_search() },
    { keys: ['↑', '↓'], text: m.shortcuts_move_in_results() },
    { keys: ['Enter'], text: m.shortcuts_choose_result() },
    { keys: ['Esc'], text: m.shortcuts_close_dialog() },
    { keys: ['Tab'], text: m.shortcuts_skip_link() },
  ])
</script>

<Dialog
  bind:open
  id="shortcuts-dialog"
  title={m.shortcuts_dialog_title()}
  description={m.shortcuts_dialog_description()}
  onclose={closeShortcuts}
>
  <dl class="flex flex-col gap-2 text-sm">
    {#each rows as row (row.text)}
      <div class="flex items-center justify-between gap-4">
        <dt class="text-slate-700">{row.text}</dt>
        <dd class="flex shrink-0 gap-1">
          {#each row.keys as key (key)}
            <kbd class="rounded border border-slate-400 px-1.5 py-0.5 text-xs">{key}</kbd>
          {/each}
        </dd>
      </div>
    {/each}
  </dl>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white"
      data-autofocus
      onclick={() => (open = false)}
    >
      {m.shortcuts_dialog_close()}
    </button>
  {/snippet}
</Dialog>
