<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageLinkPointProps } from '$lib/components/composition/injection-points.js'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'

  // Story 69.12: the header row of the "Shareable link" card (title, regenerate, disable). It gets
  // only the flags a contribution at `project.status-page.link-header` receives, never the link or the
  // token behind it. The point is the last item of the button group.
  let {
    project,
    hasPublicUrl,
    legacyToken,
    isBusy,
    onRegenerate,
    onDisable,
    data,
  }: {
    project: StatusPageLinkPointProps['project']
    hasPublicUrl: boolean
    legacyToken: boolean
    isBusy: boolean
    onRegenerate: () => void | Promise<void>
    onDisable: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.link-header -->
<div class="flex items-center justify-between">
  <h2 class="text-xl font-semibold text-slate-950">Shareable link</h2>
  <div class="flex gap-2">
    <!-- Story 6.6 AC-3/AC-6: two-step confirm (reused ConfirmDeleteButton pattern) so
         rotation always requires an explicit label + a second click that warns the old
         link stops working, instead of firing on a single click. `variant="neutral"`
         keeps this visually distinct from the genuinely irreversible Disable button next
         to it — regenerating a link is not the same severity as disabling the page. -->
    <ConfirmDeleteButton
      label={legacyToken ? 'Migrate to persistent link' : 'Regenerate link'}
      confirmLabel="Confirm — old link stops working?"
      pendingLabel={legacyToken ? 'Migrating…' : 'Regenerating…'}
      variant="neutral"
      disabled={isBusy}
      onConfirm={onRegenerate}
    />
    <button
      class="rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
      type="button"
      disabled={isBusy}
      onclick={() => onDisable()}
    >
      Disable
    </button><InjectionPoint
      name="project.status-page.link-header"
      props={{ project, hasPublicUrl, isLegacy: legacyToken }}
      {data}
    />
  </div>
</div>
