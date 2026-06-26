import {
  hashUserPassword as hashPassword,
  passwordHashConfigFromEnv,
  verifyUserPassword as verifyPassword,
} from '@project-vault/crypto'
import { env } from '../../config/env.js'

const config = passwordHashConfigFromEnv({
  memoryCost: env.ARGON2_MEMORY_COST,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
})

export function hashUserPassword(password: string): Promise<string> {
  return hashPassword(password, config)
}

export function verifyUserPassword(password: string, encodedHash: string): Promise<boolean> {
  return verifyPassword(password, encodedHash)
}
