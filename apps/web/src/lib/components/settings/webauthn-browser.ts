import { startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

export async function startHardwareKeyRegistration(
  options: PublicKeyCredentialCreationOptionsJSON
) {
  return startRegistration({ optionsJSON: options })
}
