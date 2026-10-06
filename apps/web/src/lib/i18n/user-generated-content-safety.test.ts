import { describe, expect, it } from 'vitest'
import { m } from '$lib/paraglide/messages.js'

/**
 * Story 15.1 AC 4 edge / Task 7.2 — user-generated content (credential names, project names,
 * notes) is always passed as an *interpolation argument* to a Paraglide message function, never
 * concatenated into the translatable template string itself. Paraglide's compiled output uses
 * plain JS template-literal substitution (`${i?.credentialName}`) rather than a nested
 * ICU-message parser, so a value that happens to *look* like placeholder syntax (e.g.
 * `{count} servers`) can never be reinterpreted as a nested placeholder or throw — it always
 * renders as inert literal text.
 */
describe('user-generated content is never re-parsed as message syntax (AC 4 edge)', () => {
  it('renders a credential name containing ICU-like {} syntax literally, in English', () => {
    const result = m.credential_expiry_notification(
      { credentialName: '{count} servers', days: 5 },
      { locale: 'en' }
    )

    expect(result).toBe("Secret '{count} servers' expires in 5 days")
  })

  it('renders the same literal credential name unmodified when the template is in Spanish', () => {
    const result = m.credential_expiry_notification(
      { credentialName: '{count} servers', days: 5 },
      { locale: 'es' }
    )

    // The template text translates; the user-generated credential name does not.
    expect(result).toContain('{count} servers')
    expect(result).toContain('vence en 5 días')
  })

  it('does not throw for a name containing nested/unbalanced braces', () => {
    expect(() =>
      m.credential_expiry_notification(
        { credentialName: "{{'malicious'}}", days: 1 },
        { locale: 'en' }
      )
    ).not.toThrow()
  })
})

/** Story 71.10 AC-4: an issuer-attested actor's provider and subject are external, attacker-influenced
 * text; they only ever enter a message as interpolation arguments. */
describe('issuer-attested actor text is never re-parsed as message syntax (71-10)', () => {
  it.each(['en', 'es'] as const)(
    'renders ICU-like provider and subject literally in %s',
    (locale) => {
      const result = m.audit_attr_identity(
        { provider: '{count} workos', subject: "{{'x'}} <b>Nestor</b>" },
        { locale }
      )
      expect(result).toBe("{count} workos: {{'x'}} <b>Nestor</b>")
    }
  )
})
