import type { VaultInitRequest, VaultUnsealRequest } from '$lib/api/vault.js'

export type VaultInitMode = VaultInitRequest['kmsType']
export type VaultInitFields = {
  bootstrapToken: string
  mode: VaultInitMode
  passphrase: string
  envelopeKeyPath: string
  masterKeyPath: string
}

export type VaultUnsealMode = 'passphrase' | 'envelopeKeyPath' | 'masterKeyPath'
export type VaultUnsealFields = {
  mode: VaultUnsealMode
  passphrase: string
  envelopeKeyPath: string
  masterKeyPath: string
}

export function buildVaultInitRequest(fields: VaultInitFields): VaultInitRequest {
  if (fields.mode === 'envelope') {
    return {
      kmsType: 'envelope',
      envelopeKeyPath: fields.envelopeKeyPath,
      acknowledgeSplitKeyModel: true,
    }
  }
  if (fields.mode === 'file') {
    return {
      kmsType: 'file',
      masterKeyPath: fields.masterKeyPath,
      acknowledgeCoLocationRisk: true,
    }
  }
  return { kmsType: 'passphrase', passphrase: fields.passphrase }
}

export function clearVaultInitFields(fields: VaultInitFields): VaultInitFields {
  return {
    ...fields,
    bootstrapToken: '',
    passphrase: '',
    envelopeKeyPath: '',
    masterKeyPath: '',
  }
}

export function buildVaultUnsealRequest(fields: VaultUnsealFields): VaultUnsealRequest {
  if (fields.mode === 'envelopeKeyPath') return { envelopeKeyPath: fields.envelopeKeyPath }
  if (fields.mode === 'masterKeyPath') return { masterKeyPath: fields.masterKeyPath }
  return { passphrase: fields.passphrase }
}

export function clearVaultUnsealFields(fields: VaultUnsealFields): VaultUnsealFields {
  return {
    ...fields,
    passphrase: '',
    envelopeKeyPath: '',
    masterKeyPath: '',
  }
}
