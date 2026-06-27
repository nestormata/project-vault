import { AppError } from '../../lib/errors.js'

export function normalizeEmail(input: string): string {
  const normalized = input.trim().toLowerCase().normalize('NFKC')
  if (!/^[\x21-\x7E]+$/.test(normalized)) {
    throw new AppError('validation_error', 'Email must contain ASCII characters only', 422)
  }
  return normalized
}
