export const KNOWN_ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type KnownOrgRole = (typeof KNOWN_ORG_ROLES)[number]

export function isKnownOrgRole(role: string): role is KnownOrgRole {
  return (KNOWN_ORG_ROLES as readonly string[]).includes(role)
}
