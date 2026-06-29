export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

export const CREDENTIAL_CREATOR_ROLES = ['member', 'admin', 'owner'] as const

export function canCreateCredential(orgRole: OrgRole): boolean {
  return (CREDENTIAL_CREATOR_ROLES as readonly string[]).includes(orgRole)
}

export function canCreateProject(orgRole: OrgRole): boolean {
  return canCreateCredential(orgRole)
}

export function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

export function validateCredentialForm(input: { name: string; value: string }) {
  const errors: { name?: string; value?: string } = {}
  if (!input.name.trim()) errors.name = 'Name is required'
  if (!input.value.trim()) errors.value = 'Credential value cannot be empty'
  return errors
}

export const onboardingCopy = {
  welcomeHeading: 'Welcome to Project Vault',
  projectModel:
    'Everything in Project Vault lives inside a Project. A project is a container for all the secrets, services, and certificates that belong together — like payments-api or mobile-backend. There are no environments; instead, each environment can be its own project, or you can use tags to distinguish them within a project.',
  step1Cta: "Got it — Let's add a credential",
  vaultSealedMessage:
    'The vault is sealed — credentials cannot be saved right now. Ask your administrator to unseal the vault.',
  viewerStep2Message:
    'Credential creation requires Member access. Ask your admin to upgrade your role, or explore the dashboard to see what your team has already secured.',
  viewerNoProjectsMessage:
    "Your admin hasn't created any projects yet. Check back when a project is set up for you, or ask your admin to invite you to an existing project.",
  globalSearchMention: 'Global search across all your projects is coming soon.',
} as const

export const forbiddenOnboardingTerms = [/^environment$/i] as const

export function containsForbiddenStructuralTerm(text: string): boolean {
  return forbiddenOnboardingTerms.some((pattern) => pattern.test(text.trim()))
}
