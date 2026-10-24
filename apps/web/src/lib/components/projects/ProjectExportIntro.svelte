<script lang="ts">
  import type { ProjectOverview } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the description of the export section. It is hidden while the one-time reveal is
  // open; the panel only tells it that (`revealed`), never what is revealed.
  let {
    project,
    revealed,
    data,
  }: {
    project: ProjectOverview
    revealed: boolean
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.detail.export-intro -->
<RegionFragment>
  {#if !revealed}
    <p class="mt-1 text-sm text-slate-600">
      Download an encrypted, portable snapshot of this project — every secret, dependent system,
      rotation history, service, certificate, domain, and machine user definition — as a single
      file. A random encryption key is generated and shown to you exactly once: it is never stored
      anywhere on the server. If you lose it, the export file is permanently unrecoverable — save
      the key somewhere safe before you close this page.
    </p>
  {/if}<InjectionPoint name="project.detail.export-intro" props={{ project }} {data} />
</RegionFragment>
