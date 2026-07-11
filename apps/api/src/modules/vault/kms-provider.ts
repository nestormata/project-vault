import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  type KMSClient as KMSClientType,
  type GenerateDataKeyCommandOutput,
  type DecryptCommandOutput,
} from '@aws-sdk/client-kms'
import { env } from '../../config/env.js'

/**
 * Story 1.14 AC-21: small provider interface so a future story can add a second KMS backend
 * (GCP KMS, HashiCorp Vault Transit) without touching key-service.ts's core init/unseal logic —
 * only this interface needs a second implementation, plus a provider-selection mechanism. V1
 * ships exactly one implementation, AwsKmsProvider, using @aws-sdk/client-kms.
 */
export interface KmsKeyProvider {
  generateDataKey(keyId: string): Promise<{ plaintext: Buffer; ciphertextBlob: string }>
  decryptDataKey(ciphertextBlob: string): Promise<Buffer>
}

/** Provider-agnostic error classification — key-service.ts maps `kind` to the correct
 * context-specific AppError (init vs. unseal use different status codes/messages for the same
 * underlying failure class, e.g. AC-4 vs AC-12). Never carries the raw SDK error message/stack —
 * `message` here is always this file's own sanitized text (AC-18's no-leak guarantee). */
export type KmsErrorKind = 'unreachable' | 'not_found' | 'permission_denied' | 'unknown'

export class KmsProviderError extends Error {
  constructor(
    public readonly kind: KmsErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'KmsProviderError'
  }
}

const NOT_FOUND_NAMES = new Set([
  'NotFoundException',
  'DisabledException',
  'KMSInvalidStateException',
])
const PERMISSION_DENIED_NAMES = new Set([
  'AccessDeniedException',
  'ExpiredTokenException',
  'UnrecognizedClientException',
])
// AWS SDK network/timeout/throttling failures — all treated as "unreachable" (transient,
// operator should retry/verify connectivity), not "unknown" (adversarial review finding 4/11:
// throttling is a realistic, distinct-but-related failure mode under load; folding it into
// "unreachable" rather than "unknown" gives the operator an actionable, correct-enough signal
// without inventing a fifth public error code this story's AC set never specifies).
const UNREACHABLE_NAMES = new Set([
  'TimeoutError',
  'NetworkingError',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ThrottlingException',
  'LimitExceededException',
  'KMSInternalException',
  'ServiceUnavailable',
])

function classifyKmsError(error: unknown): KmsErrorKind {
  const name = (error as { name?: string } | undefined)?.name
  if (name && NOT_FOUND_NAMES.has(name)) return 'not_found'
  if (name && PERMISSION_DENIED_NAMES.has(name)) return 'permission_denied'
  if (name && UNREACHABLE_NAMES.has(name)) return 'unreachable'
  return 'unknown'
}

/** Sanitized message per `kind` — never forwards the raw SDK error's `.message`/`.stack` (AC-18). */
function wrapKmsError(error: unknown, operation: 'generateDataKey' | 'decryptDataKey'): never {
  const kind = classifyKmsError(error)
  let message: string
  switch (kind) {
    case 'unreachable':
      message = `KMS ${operation} could not reach the configured provider`
      break
    case 'not_found':
      message = `KMS ${operation} target key was not found or is not usable`
      break
    case 'permission_denied':
      message = `KMS ${operation} was denied by IAM/key policy`
      break
    default:
      message = `KMS ${operation} failed`
  }
  throw new KmsProviderError(kind, message)
}

type MinimalKmsClient = Pick<KMSClientType, 'send'>

/** Story 1.14 AC-1/AC-9/AC-21/AC-22: AWS KMS implementation of KmsKeyProvider, mirroring
 * `backup/storage.ts`'s S3Client construction pattern — no required credentials env var (relies
 * on the AWS SDK's standard credential-provider chain), optional `VAULT_KMS_ENDPOINT` override
 * for LocalStack/tests only (never consulted in production unless explicitly set). */
export class AwsKmsProvider implements KmsKeyProvider {
  private readonly client: MinimalKmsClient

  constructor(client?: MinimalKmsClient) {
    this.client =
      client ??
      new KMSClient({
        ...(env.VAULT_KMS_ENDPOINT ? { endpoint: env.VAULT_KMS_ENDPOINT } : {}),
      })
  }

  async generateDataKey(keyId: string): Promise<{ plaintext: Buffer; ciphertextBlob: string }> {
    let result: GenerateDataKeyCommandOutput
    try {
      result = (await this.client.send(
        new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' })
      )) as GenerateDataKeyCommandOutput
    } catch (error) {
      wrapKmsError(error, 'generateDataKey')
    }
    const { Plaintext: plaintext, CiphertextBlob: ciphertextBlob } = result
    if (!plaintext || !ciphertextBlob) {
      throw new KmsProviderError('unknown', 'KMS generateDataKey returned an incomplete response')
    }
    return {
      plaintext: Buffer.from(plaintext),
      ciphertextBlob: Buffer.from(ciphertextBlob).toString('base64'),
    }
  }

  async decryptDataKey(ciphertextBlob: string): Promise<Buffer> {
    let result: DecryptCommandOutput
    try {
      result = (await this.client.send(
        new DecryptCommand({ CiphertextBlob: Buffer.from(ciphertextBlob, 'base64') })
      )) as DecryptCommandOutput
    } catch (error) {
      wrapKmsError(error, 'decryptDataKey')
    }
    const { Plaintext: plaintext } = result
    if (!plaintext) {
      throw new KmsProviderError('unknown', 'KMS decryptDataKey returned an incomplete response')
    }
    return Buffer.from(plaintext)
  }
}
