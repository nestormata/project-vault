<script lang="ts">
  import { enhance } from '$app/forms'
  import type { PageProps } from './$types.js'

  let { data, form }: PageProps = $props()
</script>

<svelte:head>
  <title>mock-ui-pack dashboard</title>
</svelte:head>

<section data-testid="mock-dashboard">
  <h1>mock-ui-pack:m1-dashboard</h1>
  <p data-testid="mock-dashboard-load">{data.mockDashboard}</p>
  <p data-testid="mock-dashboard-user">{data.mockUserId ?? 'none'}</p>
  <p data-testid="mock-dashboard-org">{data.mockOrgName ?? 'none'}</p>
  <a href="?mock-redirect=1" data-testid="mock-dashboard-redirect">Redirect me</a>
  <form method="POST" action="?/note" use:enhance>
    <label for="mock-dashboard-note">Note</label>
    <input id="mock-dashboard-note" name="note" aria-describedby="mock-dashboard-note-help" />
    <p id="mock-dashboard-note-help">A short note kept for this page only.</p>
    <button type="submit">Save note</button>
  </form>
  {#if form && 'mockNote' in form}
    <p data-testid="mock-dashboard-note-result">{form.mockNote}</p>
  {/if}
  {#if form && 'mockNoteError' in form}
    <p data-testid="mock-dashboard-note-error">{form.mockNoteError}</p>
  {/if}
</section>
