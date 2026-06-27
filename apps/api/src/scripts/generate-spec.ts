import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../../../../packages/shared/openapi.json')
const AUTH_TAG = 'auth'
const VALIDATION_ERROR = 'Validation error'
const AUTH_REJECTED = 'Access token missing, invalid, revoked, or expired'

writeFileSync(
  outPath,
  JSON.stringify(
    {
      openapi: '3.0.0',
      info: { title: 'Project Vault', version: '0.0.1' },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'access-token',
          },
        },
      },
      paths: {
        '/api/v1/auth/register': {
          post: {
            tags: [AUTH_TAG],
            summary: 'Register a user and organization',
            responses: {
              '201': { description: 'User and organization registered' },
              '403': { description: 'Registration disabled' },
              '409': { description: 'Email or organization name unavailable' },
              '422': { description: VALIDATION_ERROR },
            },
          },
        },
        '/api/v1/auth/login': {
          post: {
            tags: [AUTH_TAG],
            summary: 'Create an authenticated session',
            responses: {
              '200': { description: 'Session cookies set' },
              '401': { description: 'Invalid credentials' },
              '422': { description: VALIDATION_ERROR },
            },
          },
        },
        '/api/v1/auth/refresh': {
          post: {
            tags: [AUTH_TAG],
            summary: 'Rotate refresh token and issue a new access token',
            responses: {
              '200': { description: 'Session refreshed' },
              '401': { description: 'Refresh token missing, invalid, expired, or revoked' },
            },
          },
        },
        '/api/v1/auth/me': {
          get: {
            tags: [AUTH_TAG],
            summary: 'Return current authenticated session context',
            security: [{ cookieAuth: [] }],
            responses: {
              '200': { description: 'Authenticated session context' },
              '401': { description: AUTH_REJECTED },
              '403': { description: 'Account deactivated' },
            },
          },
        },
        '/api/v1/auth/sessions': {
          get: {
            tags: [AUTH_TAG],
            summary: 'List active sessions for the current user',
            security: [{ cookieAuth: [] }],
            responses: {
              '200': { description: 'Active sessions' },
              '401': { description: AUTH_REJECTED },
            },
          },
          delete: {
            tags: [AUTH_TAG],
            summary: 'Revoke all sessions except the current session',
            security: [{ cookieAuth: [] }],
            responses: {
              '200': { description: 'Other sessions revoked' },
              '401': { description: AUTH_REJECTED },
            },
          },
        },
        '/api/v1/auth/sessions/{sessionId}': {
          delete: {
            tags: [AUTH_TAG],
            summary: 'Revoke one owned session',
            security: [{ cookieAuth: [] }],
            parameters: [
              {
                name: 'sessionId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              '204': { description: 'Session revoked' },
              '401': { description: AUTH_REJECTED },
              '404': { description: 'Session not found' },
              '422': { description: VALIDATION_ERROR },
            },
          },
        },
        '/api/v1/auth/logout': {
          post: {
            tags: [AUTH_TAG],
            summary: 'Revoke current session and clear auth cookies',
            security: [{ cookieAuth: [] }],
            responses: {
              '204': { description: 'Logged out' },
              '401': { description: AUTH_REJECTED },
            },
          },
        },
        '/api/v1/org/users/{userId}/sessions': {
          delete: {
            tags: ['org'],
            summary: 'Revoke all sessions for a user in the current organization',
            security: [{ cookieAuth: [] }],
            parameters: [
              {
                name: 'userId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              '200': { description: 'User sessions revoked' },
              '401': { description: AUTH_REJECTED },
              '403': { description: 'Insufficient role' },
              '404': { description: 'User not found' },
              '422': { description: VALIDATION_ERROR },
            },
          },
        },
      },
    },
    null,
    2
  ) + '\n'
)
