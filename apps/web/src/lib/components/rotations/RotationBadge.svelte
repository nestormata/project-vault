<script lang="ts">
  import { resolve } from '$app/paths'
  import { rotationBadgeLabel, rotationStatusBadgeClass } from './rotation-copy.js'
  import type { RotationStatus } from '@project-vault/shared'

  // Story 18.5 AC-1/AC-2/AC-3/AC-6/AC-7: the shared "rotation in progress" indicator used by both
  // the credential list and the dashboard's "Upcoming rotations" section — reuses the existing
  // per-status badge color classes (rotationStatusBadgeClass) so this never invents new badge
  // markup, and pairs color with an icon + distinct label text (never color alone). `href` is an
  // unresolved app-relative path (mirrors PageAlertBanner's `backHref`/FormSubmitRow's
  // `cancelHref` convention) — resolved here, not by the caller.
  let { status, href }: { status: RotationStatus; href: string } = $props()
</script>

<a
  class={`inline-flex items-center gap-1 ${rotationStatusBadgeClass(status)}`}
  href={resolve(href)}
  title={`Rotation status: ${status}`}
>
  <span aria-hidden="true">&#8635;</span>
  {rotationBadgeLabel(status)}
</a>
