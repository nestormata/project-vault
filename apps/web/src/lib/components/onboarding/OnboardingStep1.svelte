<script lang="ts">
  import { createProject, suggestProjectSlug } from '$lib/api/projects.js'
  import { ApiClientError } from '$lib/api/client.js'
  import type { OrgRole } from './onboarding-logic.js'
  import { canCreateProject, onboardingCopy } from './onboarding-logic.js'

  let {
    orgName,
    orgRole,
    hasProject,
    onProjectReady,
    onContinue,
    onDismiss,
    headingId,
  }: {
    orgName: string
    orgRole: OrgRole
    hasProject: boolean
    onProjectReady: (projectId: string) => void
    onContinue: () => void
    onDismiss: () => void
    headingId: string
  } = $props()

  let projectName = $state('')
  let creating = $state(false)
  let errorMessage = $state<string | null>(null)

  const canCreate = $derived(canCreateProject(orgRole))

  async function createFirstProject() {
    if (creating || !projectName.trim()) return
    creating = true
    errorMessage = null
    try {
      const project = await createProject(fetch, {
        name: projectName.trim(),
        slug: suggestProjectSlug(projectName),
      })
      onProjectReady(project.id)
    } catch (error) {
      errorMessage =
        error instanceof ApiClientError ? error.message : 'Project creation failed. Try again.'
    } finally {
      creating = false
    }
  }
</script>

{#if !hasProject && !canCreate}
  <section>
    <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">
      Welcome to {orgName}
    </h2>
    <p class="mt-4 text-slate-700">{onboardingCopy.viewerNoProjectsMessage}</p>
    <button
      class="mt-6 min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white"
      type="button"
      onclick={onDismiss}
    >
      Got it
    </button>
  </section>
{:else if !hasProject && canCreate}
  <section>
    <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">
      First, create a project
    </h2>
    <p class="mt-2 text-slate-700">What is this project for?</p>
    <label class="mt-4 block text-sm font-medium text-slate-800" for="onboarding-project-name">
      Project name
    </label>
    <input
      id="onboarding-project-name"
      class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3"
      type="text"
      autocomplete="off"
      bind:value={projectName}
    />
    {#if errorMessage}
      <p class="mt-2 text-sm text-red-700" role="alert">{errorMessage}</p>
    {/if}
    <button
      class="mt-6 min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
      type="button"
      disabled={creating || !projectName.trim()}
      onclick={createFirstProject}
    >
      {creating ? 'Creating…' : 'Create Project'}
    </button>
  </section>
{:else}
  <section>
    <h2 id={headingId} class="text-2xl font-semibold text-slate-950" tabindex="-1">
      {onboardingCopy.welcomeHeading}
    </h2>
    <div class="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-hidden="true">
      <svg class="w-full" viewBox="0 0 360 120" role="img">
        <rect x="10" y="20" width="100" height="36" rx="8" fill="#0f172a" />
        <text x="60" y="43" text-anchor="middle" fill="white" font-size="12">Organization</text>
        <line x1="110" y1="38" x2="140" y2="38" stroke="#64748b" stroke-width="2" />
        <rect x="140" y="20" width="90" height="36" rx="8" fill="#334155" />
        <text x="185" y="43" text-anchor="middle" fill="white" font-size="12">Project</text>
        <line x1="230" y1="38" x2="260" y2="38" stroke="#64748b" stroke-width="2" />
        <rect x="260" y="10" width="90" height="24" rx="6" fill="#cbd5e1" />
        <rect x="260" y="42" width="90" height="24" rx="6" fill="#cbd5e1" />
        <rect x="260" y="74" width="90" height="24" rx="6" fill="#cbd5e1" />
        <text x="305" y="26" text-anchor="middle" fill="#0f172a" font-size="10">Credentials</text>
        <text x="305" y="58" text-anchor="middle" fill="#0f172a" font-size="10">Services</text>
        <text x="305" y="90" text-anchor="middle" fill="#0f172a" font-size="10">Certificates</text>
      </svg>
    </div>
    <p class="mt-4 text-slate-700">{onboardingCopy.projectModel}</p>
    <button
      class="mt-6 min-h-11 min-w-11 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white"
      type="button"
      onclick={onContinue}
    >
      {onboardingCopy.step1Cta}
    </button>
  </section>
{/if}
