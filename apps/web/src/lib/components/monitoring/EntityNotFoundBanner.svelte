<!--
  Full-width "not found" notice shown on a monitored-asset detail page when the entity itself is
  missing or inaccessible (as opposed to ProjectNotFoundBanner, which covers the parent project).
  Shared by the certificates/domains/services/service-endpoints detail pages.
-->
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    title,
    message,
    backHref,
    backLabel,
  }: {
    title: string
    message: string
    backHref: string
    backLabel: string
  } = $props()
</script>

<div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
  <h1 class="text-xl font-semibold text-red-900">{title}</h1>
  <p class="mt-2 text-red-800">{message}</p>
  <a class="mt-4 inline-block font-medium text-slate-950 underline" href={resolve(backHref)}>
    {backLabel}
  </a>
</div>
