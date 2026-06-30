<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    title,
    message,
    backHref,
    backLabel = 'Back',
  }: {
    title: string
    message: string
    backHref: string
    backLabel?: string
  } = $props()
</script>

<div class="rounded-2xl border border-red-200 bg-red-50 p-6" role="alert">
  <h2 class="text-lg font-semibold text-red-900">{title}</h2>
  <p class="mt-2 text-red-800">{message}</p>
  <a class="mt-4 inline-block font-medium text-slate-950 underline" href={resolve(backHref)}>
    {backLabel}
  </a>
</div>
