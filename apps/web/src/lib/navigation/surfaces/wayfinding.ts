// Story 68.7 (S14-S16): page back links (one item per page), the error page's way back and the
// auth pages' cross-links (the anchor only; the sentence around it stays page copy).
import { resolve } from '$app/paths'
import { m } from '$lib/paraglide/messages.js'
import type { NavContexts } from '../types.js'
import type { PvItem, SurfaceBuilder } from './define.js'
import { text } from './define.js'

type Back = PvItem<NavContexts['back']>

const BACK_TO_SECRETS = 'Back to secrets'

const settings = (id: Back['id']): Back => ({
  id,
  label: text('← Settings'),
  href: () => resolve('/settings'),
})

const auditLog = (id: Back['id']): Back => ({
  id,
  label: text('← Back to Audit Log'),
  href: () => resolve('/settings/audit'),
})

function projectBack(id: Back['id'], label: string, section: string): Back {
  return {
    id,
    label: text(label),
    href: (ctx) => resolve(`/projects/${ctx.projectId}/${section}`),
  }
}

export const backItems: SurfaceBuilder<'back'> = () => [
  settings('back.settings.security'),
  settings('back.settings.language'),
  settings('back.settings.themes'),
  settings('back.settings.notifications'),
  auditLog('back.settings.audit.access-report'),
  auditLog('back.settings.audit.forwarding'),
  {
    id: 'back.settings.users.erasure',
    label: text('← Back to Users'),
    href: () => resolve('/settings/users'),
  },
  projectBack('back.project.machine-users', BACK_TO_SECRETS, 'credentials'),
  projectBack('back.project.credentials.import', BACK_TO_SECRETS, 'credentials'),
  projectBack('back.project.credential', BACK_TO_SECRETS, 'credentials'),
  projectBack('back.project.machine-user', 'Back to machine users', 'machine-users'),
  {
    id: 'back.project.rotation',
    label: text('Back to secret'),
    href: (ctx) => resolve(`/projects/${ctx.projectId}/credentials/${ctx.credentialId}`),
  },
  projectBack('back.project.service-endpoint', 'Back to endpoints', 'service-endpoints'),
  projectBack('back.project.service', 'Back to services', 'services'),
  projectBack('back.project.certificate', 'Back to certificates', 'certificates'),
  projectBack('back.project.domain', 'Back to domains', 'domains'),
]

export const errorNavItems: SurfaceBuilder<'error.nav'> = () => [
  {
    id: 'error.nav.back',
    label: (ctx) => (ctx.authenticated ? 'Back to Dashboard' : 'Back to Project Vault'),
    href: (ctx) => (ctx.authenticated ? resolve('/dashboard') : resolve('/')),
  },
]

export const authLinkItems: SurfaceBuilder<'auth.links'> = () => [
  {
    id: 'auth.links.login.register',
    label: () => m.auth_login_register_link(),
    href: () => resolve('/register'),
  },
  {
    id: 'auth.links.login.recovery',
    label: () => m.auth_login_recovery_link(),
    href: () => resolve('/recovery'),
  },
  {
    id: 'auth.links.register.login',
    label: () => m.auth_login_sign_in(),
    href: () => resolve('/login'),
  },
  {
    id: 'auth.links.recovery.login',
    label: text('Sign in'),
    href: () => resolve('/login'),
  },
]
