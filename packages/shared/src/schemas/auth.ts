import { z } from 'zod/v4'

export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(12).max(256),
    orgName: z.string().min(1).max(128).trim(),
  })
  .meta({ id: 'RegisterRequest' })

export const LoginRequestSchema = z
  .object({
    email: z.email().max(254),
    password: z.string().min(1).max(256),
  })
  .meta({ id: 'LoginRequest' })

export const AuthSessionResponseSchema = z
  .object({
    userId: z.uuid(),
    orgId: z.uuid(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'AuthSessionResponse' })

export const RegisterResponseSchema = z
  .object({
    userId: z.uuid(),
    orgId: z.uuid(),
    email: z.email(),
    orgName: z.string(),
    role: z.enum(['owner']),
  })
  .meta({ id: 'RegisterResponse' })

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>
export type LoginRequest = z.infer<typeof LoginRequestSchema>
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>
