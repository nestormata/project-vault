<script lang="ts">
  // Story 69.13 M3 region point: `root.error.content` on the root error page. A render-only fill:
  // an error page has no load, so it must still render when the page is reached by a 404 and by a 500.
  import { page } from '$app/state'
</script>

<p data-testid="mock-p13-error-content" data-status={page.status}>
  mock-ui-pack:m3-p13-root.error.content
</p>
