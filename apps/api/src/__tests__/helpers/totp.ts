import * as OTPAuth from 'otpauth'

export function totpForSecret(base32: string, timestamp = Date.now()): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(base32),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate({ timestamp })
}
