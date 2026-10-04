<script lang="ts">
  import { page } from '$app/state'
</script>

<!-- M1 (d): a root error page. It prints SvelteKit's sanitised message, never a stack. -->
<main data-testid="mock-error">
  <h1>mock-ui-pack:m1-error</h1>
  <p data-testid="mock-error-status">{page.status}</p>
  <p data-testid="mock-error-message">{page.error?.message ?? ''}</p>
</main>
