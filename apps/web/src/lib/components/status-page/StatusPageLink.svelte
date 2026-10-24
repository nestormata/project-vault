<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { StatusPageLinkPointProps } from '$lib/components/composition/injection-points.js'
  import StatusPageLinkDisplay from './StatusPageLinkDisplay.svelte'
  import StatusPageLinkHeader from './StatusPageLinkHeader.svelte'

  // Story 69.3: the "Shareable link" card (regenerate, disable, the link itself) as one replaceable
  // region. It renders only when the page is enabled and the caller can manage it. `publicUrl` holds
  // the bearer token and stays in this component and the link display: a contribution at
  // `project.status-page.link` receives `{ project, hasPublicUrl, isLegacy }` (flags), never the
  // token or the URL (AC-6.6).
  // Story 69.12: the card holds two sub-regions (the header row, the link display), each with its
  // own point.
  let {
    project,
    publicUrl,
    legacyToken,
    copied,
    isBusy,
    onRegenerate,
    onDisable,
    onCopy,
    data,
  }: {
    project: StatusPageLinkPointProps['project']
    publicUrl: string | null
    legacyToken: boolean
    copied: boolean
    isBusy: boolean
    onRegenerate: () => void | Promise<void>
    onDisable: () => void | Promise<void>
    onCopy: () => void | Promise<void>
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.status-page.link -->
<div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <StatusPageLinkHeader
    {project}
    hasPublicUrl={Boolean(publicUrl)}
    {legacyToken}
    {isBusy}
    {onRegenerate}
    {onDisable}
    {data}
  />

  <StatusPageLinkDisplay
    {project}
    {publicUrl}
    {legacyToken}
    {copied}
    {onCopy}
    {data}
  /><InjectionPoint
    name="project.status-page.link"
    props={{ project, hasPublicUrl: Boolean(publicUrl), isLegacy: legacyToken }}
    {data}
  />
</div>
