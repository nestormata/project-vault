import { expect, type Locator, type Page } from '@playwright/test'

// The app confirms destructive actions in its own native dialog (Story 72.5), named by its title.
// Returns the dialog so a caller can assert on the message before confirming.
export async function openConfirmDialog(page: Page, title: string): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  return dialog
}

export async function confirmDialog(
  page: Page,
  title: string,
  confirmLabel: string,
  message?: RegExp
): Promise<void> {
  const dialog = await openConfirmDialog(page, title)
  if (message) await expect(dialog).toContainText(message)
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click()
  await expect(dialog).toBeHidden()
}
