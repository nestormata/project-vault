export type PrimaryNavItem = {
  label: string
  mobileLabel: string
  href: string
}

const primaryNavItems: PrimaryNavItem[] = [
  { label: 'Dashboard', mobileLabel: 'Dashboard', href: '/dashboard' },
  { label: 'Projects', mobileLabel: 'Projects', href: '/projects' },
  { label: 'Credentials', mobileLabel: 'Creds', href: '/credentials' },
  { label: 'Alerts', mobileLabel: 'Alerts', href: '/notifications' },
  { label: 'Health', mobileLabel: 'Health', href: '/health' },
  { label: 'Settings', mobileLabel: 'Settings', href: '/settings' },
]

export function getPrimaryNavItems() {
  return primaryNavItems
}

export function isActiveNavItem(itemHref: string, pathname: string) {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}
