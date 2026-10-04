<script lang="ts">
  import { enhance } from '$app/forms'
  import RecentActivitySection from '$lib/components/dashboard/RecentActivitySection.svelte'
  import type { PageProps } from './$types.js'

  let { data, form }: PageProps = $props()

  // Story 69.1: the override builds on one of PV's dashboard region components (the way CM's own
  // dashboard override does), so a region point renders inside a page the pack replaced.
  const mockProject = {
    id: 'mock-project',
    name: 'mock-ui-pack project',
    slug: 'mock-ui-pack-project',
    description: null,
    role: 'owner' as const,
    credentialCount: 0,
    expiringCount: 0,
    alertCount: 0,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    isArchived: false,
  }
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
  <RecentActivitySection project={mockProject} events={[]} data={data.__inject} />
</section>
