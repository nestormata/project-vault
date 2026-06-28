import type { VaultReadiness } from '$lib/api/vault.js'

export type VaultGateModel = {
  eyebrow: string
  title: string
  message: string
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
      primaryAction: 'Retry readiness',
      showInit: false,
      showUnseal: false,
    }
  }

  return {
    eyebrow: 'Vault ready',
    title: 'Project Vault is ready',
    message: 'Continue to sign in or register.',
    primaryAction: null,
    showInit: false,
    showUnseal: false,
  }
}
