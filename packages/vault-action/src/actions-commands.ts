import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { EOL } from 'node:os'

// Minimal in-repo replacement for the few GitHub Actions runner commands this action uses. Kept
// deliberately small: no OIDC, no HTTP, no outputs/paths. Behaviour matches `@actions/core@3.0.1`
// except `exportVariable`, which fails closed instead of falling back to the removed `::set-env`
// stdout command (that fallback would print the secret value to the log).

/** Actions "data" escaping: `%` first, then CR, then LF. */
function escapeData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function issueCommand(command: string, message: string): void {
  process.stdout.write(`::${command}::${escapeData(message)}${EOL}`)
}

export function getInput(name: string, options?: { required?: boolean }): string {
  const raw = process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? ''
  if (options?.required && raw === '') {
    throw new Error(`Input required and not supplied: ${name}`)
  }
  return raw.trim()
}

export function getBooleanInput(name: string): boolean {
  const value = getInput(name)
  if (['true', 'True', 'TRUE'].includes(value)) return true
  if (['false', 'False', 'FALSE'].includes(value)) return false
  throw new TypeError(
    `Input does not meet YAML 1.2 "Core Schema" specification: ${name}\n` +
      `Support boolean input list: \`true | True | TRUE | false | False | FALSE\``
  )
}

export function setSecret(value: string): void {
  issueCommand('add-mask', value)
}

export function exportVariable(name: string, value: string): void {
  if (name === '' || /[\r\n=]|<</.test(name)) {
    throw new Error('Invalid environment variable name')
  }
  const delimiter = `ghadelimiter_${randomUUID()}`
  if (name.includes(delimiter) || value.includes(delimiter)) {
    throw new Error('Unexpected input: name or value contains the generated delimiter')
  }
  const filePath = process.env['GITHUB_ENV']
  if (filePath === undefined || filePath === '') {
    throw new Error(`GITHUB_ENV is not set; cannot export ${name}`)
  }
  if (!existsSync(filePath)) {
    throw new Error(`Missing file at path: ${filePath}`)
  }
  Object.assign(process.env, { [name]: value })
  appendFileSync(filePath, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, 'utf8')
}

export function setFailed(message: string): void {
  process.exitCode = 1
  issueCommand('error', message)
}

export function warning(message: string): void {
  issueCommand('warning', message)
}

export function info(message: string): void {
  process.stdout.write(`${message}${EOL}`)
}

export function debug(message: string): void {
  issueCommand('debug', message)
}
