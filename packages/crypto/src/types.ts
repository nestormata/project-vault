export type EncryptedValue = {
  version: number
  iv: string // hex
  ciphertext: string // hex
  tag: string // hex
}
