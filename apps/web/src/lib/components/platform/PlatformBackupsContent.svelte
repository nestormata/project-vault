<script lang="ts">
  import type { PageData } from '../../../routes/(app)/platform/backups/$types.js'
  import type { Snippet } from 'svelte'
  import PlatformBreadcrumb from '$lib/components/platform/PlatformBreadcrumb.svelte'
  import { BackupsController } from './backups-controller.svelte.js'
  import PlatformBackupsAlerts from './PlatformBackupsAlerts.svelte'
  import PlatformBackupsIntro from './PlatformBackupsIntro.svelte'
  import PlatformBackupsList from './PlatformBackupsList.svelte'

  // Story 69.14: the backups page is its breadcrumb plus three sub-regions (intro with the trigger,
  // the alerts, the backup list), each hosting its own point. The page's loaded data stays
  // `pageData`; `data` is the page's `__inject` map. The controller is the one owner of the list
  // and of every trigger, validate and restore state.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const controller = new BackupsController(() => (pageData.allowed ? pageData.backups : []))
  const pageError = $derived<string | null>(pageData.allowed ? pageData.errorMessage : null)
</script>

<PlatformBreadcrumb allowed={pageData.allowed} node="breadcrumbs.platform.backups">
  <PlatformBackupsIntro {controller} {data} />

  <PlatformBackupsAlerts {controller} {pageError} {data} />

  <PlatformBackupsList {controller} {pageError} {data} />
</PlatformBreadcrumb>
{@render children?.()}
