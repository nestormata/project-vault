<script lang="ts">
  // Story 68-15 (M3 on a session-bearing page): renders what the contribution load saw as the
  // caller. The text lives in plain markup, so the SSR HTML and the client chunk both carry it.
  let { data = null }: { data?: { who?: string; project?: number } | null } = $props()
  // Effects run only in the browser, after the component hydrated: the browser cases wait on this.
  let hydrated = $state(false)
  $effect(() => {
    hydrated = true
  })
</script>

<div data-testid="inject-who" data-marker="PV_INJECT_WHO_MARKER_71c2e4" data-hydrated={hydrated}>
  <span data-testid="inject-who-id">{data?.who ?? 'who:none'}</span>
  <span data-testid="inject-who-project">project-status:{data?.project ?? 'none'}</span>
</div>
