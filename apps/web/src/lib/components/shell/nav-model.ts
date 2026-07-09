export type PrimaryNavItem = {
  label: string
  mobileLabel: string
  href: string
}

const basePrimaryNavItems: PrimaryNavItem[] = [
  { label: 'Dashboard', mobileLabel: 'Dashboard', href: '/dashboard' },
  { label: 'Projects', mobileLabel: 'Projects', href: '/projects' },
  { label: 'Credentials', mobileLabel: 'Creds', href: '/credentials' },
  { label: 'Alerts', mobileLabel: 'Alerts', href: '/notifications' },
  { label: 'Health', mobileLabel: 'Health', href: '/health' },
  { label: 'Settings', mobileLabel: 'Settings', href: '/settings' },
]

const platformAdminNavItem: PrimaryNavItem = {
  label: 'Platform Admin',
  mobileLabel: 'Platform',
  href: '/platform',
}

export function getPrimaryNavItems(
  opts: { isPlatformOperator: boolean } = { isPlatformOperator: false }
): PrimaryNavItem[] {
  if (opts.isPlatformOperator) {
    return [...basePrimaryNavItems, platformAdminNavItem]
  }
  return basePrimaryNavItems
}

export function isActiveNavItem(itemHref: string, pathname: string) {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}
