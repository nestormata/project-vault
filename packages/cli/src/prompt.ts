import { createInterface } from 'node:readline/promises'

/**
 * AC-2/Dev Notes decision #3 — the interactive-prompt seam `login`'s tests inject a fake
 * implementation of, exactly the way `get`'s tests inject fake streams (see `GetStreams` in
 * get-command.ts). `mask: true` is used for the password prompt (no local echo); the TOTP prompt
 * uses `mask: false` (a TOTP code is not a long-lived secret the way a password is, and plain
 * echo makes it easier for a user to confirm they typed it correctly).
 */
export type PromptFn = (question: string, opts: { mask: boolean }) => Promise<string>

/** Thrown by `createRealPrompt()`'s implementation when the user aborts (Ctrl+C) while a prompt
 * is awaiting input — AC-2's "interrupt mid-prompt" edge case. Distinguished from every other
 * error so callers can print a clean cancellation message instead of a raw exception. */
export class PromptInterruptedError extends Error {
  constructor() {
    super('Prompt interrupted by the user (SIGINT).')
    this.name = 'PromptInterruptedError'
  }
}

/**
 * The real entry point's prompt implementation (see bin.ts). Unmasked prompts (email, TOTP) use
 * `node:readline/promises` directly for normal line editing. Masked prompts (password) read raw
 * keystrokes without echoing them, restoring the terminal's mode afterwards either way.
 */
export function createRealPrompt(): PromptFn {
  return async (question, opts) => {
    if (!opts.mask) {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    }
    return promptMasked(question)
  }
}

function promptMasked(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write(question)
    let input = ''
    const isTTY = Boolean(stdin.isTTY)
    const wasRaw = isTTY && Boolean(stdin.isRaw)
    if (isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup()
          stdout.write('\n')
          reject(new PromptInterruptedError())
          return
        }
        if (char === '\n' || char === '\r') {
          cleanup()
          stdout.write('\n')
          resolve(input)
          return
        }
        if (char === '\u007f' || char === '\b') {
          if (input.length > 0) input = input.slice(0, -1)
          continue
        }
        input += char
      }
    }
    stdin.on('data', onData)
  })
}
