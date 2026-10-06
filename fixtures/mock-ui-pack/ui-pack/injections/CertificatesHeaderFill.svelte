<script lang="ts">
  import { enhance } from '$app/forms'

  // Story 69.6 M3 region point: `project.certificates.list-header`, right after the header card of
  // the certificates list. The load reads the project through the caller's own session (the real API
  // answers another org's id like a nonexistent one); the action writes one audit row through the
  // pack's module route.
  let {
    data = null,
    params = {},
  }: {
    data?: { projectStatus?: number; projects?: number } | null
    params?: Record<string, string>
  } = $props()
</script>

<div data-testid="mock-p6-certs-header" data-project={params['projectId'] ?? ''}>
  <p data-testid="mock-p6-certs-text">
    mock-ui-pack:m3-p6-project.certificates.list-header status={data?.projectStatus ?? 'none'} projects={data?.projects ??
      'none'}
  </p>
  <form method="POST" action="?/project.certificates.list-header.note" use:enhance>
    <label for="mock-p6-certs-title">Note title</label>
    <input id="mock-p6-certs-title" name="title" aria-describedby="mock-p6-certs-help" />
    <p id="mock-p6-certs-help">Saved through the pack's own API route.</p>
    <button type="submit">Save note</button>
  </form>
</div>
