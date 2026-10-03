// Story 68.9: a CM file that keeps a non-sensitive draft id in session storage. The pack's guard
// entries (`pv-guards.ts`) declare this file and exactly this key, so PV's browser-storage guard
// passes it. The integration job's mutations remove the entry or change the key and expect red. The
// key is written as a literal at each call: the guard checks literal keys per file.
export function rememberBillingDraft(id: string): void {
  globalThis.sessionStorage?.setItem('cm:billing-draft', id)
}

export function forgetBillingDraft(): void {
  globalThis.sessionStorage?.removeItem('cm:billing-draft')
}
