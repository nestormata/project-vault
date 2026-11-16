import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'

export type WebAuthnCreationOptions = PublicKeyCredentialCreationOptionsJSON
export type WebAuthnAttestation = RegistrationResponseJSON

function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

export async function createRegistrationOptions(input: {
  rpName: string
  rpID: string
  userName: string
  userID: Uint8Array
  excludeCredentialIds: string[]
}): Promise<{ challenge: string; options: WebAuthnCreationOptions }> {
  const options = await generateRegistrationOptions({
    rpName: input.rpName,
    rpID: input.rpID,
    userName: input.userName,
    userID: toArrayBufferBytes(input.userID),
    attestationType: 'none',
    excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'cross-platform',
    },
  })
  return { challenge: options.challenge, options }
}

export type VerifiedAttestation = {
  verified: true
  credentialId: string
  publicKey: Uint8Array
  signCount: number
  transports?: string[]
  aaguid?: string
}

export async function verifyAttestation(input: {
  response: WebAuthnAttestation
  expectedChallenge: string
  expectedOrigin: string
  expectedRPID: string
}): Promise<VerifiedAttestation | { verified: false }> {
  const result = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRPID,
    requireUserVerification: false,
  })
  const info = result.registrationInfo
  if (!result.verified || !info?.credential) return { verified: false }
  return {
    verified: true,
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    signCount: info.credential.counter,
    transports: info.credential.transports,
    aaguid: info.aaguid,
  }
}
