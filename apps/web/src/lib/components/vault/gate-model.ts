import type { VaultReadiness } from '$lib/api/vault.js'

export type VaultGateModel = {
  eyebrow: string
  title: string
  message: string
  // AC-9/10/11: static, in-product copy explaining what each vault state actually means — added
  // independently of whatever `readiness.message` the API returns, since that field's content is
  // outside this app's control and may be empty/missing. Always non-empty for the three gated
  // states below, so the explanation never silently disappears if the API message is blank.
  explanation: string
  primaryAction: 'Initialize vault' | 'Unseal vault' | 'Retry readiness' | null
  showInit: boolean
  showUnseal: boolean
}

export function getVaultGateModel(readiness: VaultReadiness): VaultGateModel {
  if (readiness.state === 'uninitialized') {
    return {
      eyebrow: 'Vault setup',
      title: 'Initialize vault',
      message: readiness.message,
      explanation:
        'This vault has never been set up — it has no master encryption key yet. Provide an initialization method below to generate one before anyone can store or read credentials.',
      primaryAction: 'Initialize vault',
      showInit: true,
      showUnseal: false,
    }
  }

  if (readiness.state === 'sealed') {
    return {
      eyebrow: 'Vault locked',
      title: 'Unseal vault',
      message: readiness.message,
      explanation:
        "The vault's encryption key is not currently loaded into memory. This happens after a restart or an explicit re-seal. Enter the unseal passphrase below to continue.",
      primaryAction: 'Unseal vault',
      showInit: false,
      showUnseal: true,
    }
  }

  if (readiness.state === 'unavailable') {
    return {
      eyebrow: 'Vault unavailable',
      title: 'Project Vault is not ready',
      message: readiness.message,
      explanation:
        'Project Vault could not reach its backing vault store just now. This is usually transient — the vault host may be starting up or briefly unreachable. Try again in a moment; if it persists, contact your administrator.',
      primaryAction: 'Retry readiness',
      showInit: false,
      showUnseal: false,
    }
  }

  return {
    eyebrow: 'Vault ready',
    title: 'Project Vault is ready',
    message: 'Continue to sign in or register.',
    explanation: '',
    primaryAction: null,
    showInit: false,
    showUnseal: false,
  }
}
