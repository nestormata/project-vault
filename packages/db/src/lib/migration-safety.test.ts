import { describe, expect, it } from 'vitest'
import { findDestructiveStatements } from './migration-safety.js'

describe('findDestructiveStatements', () => {
  it('flags DROP COLUMN', () => {
    const findings = findDestructiveStatements('ALTER TABLE credentials DROP COLUMN notes;')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatch(/DROP COLUMN/i)
  })

  it('flags DROP TABLE', () => {
    const findings = findDestructiveStatements('DROP TABLE legacy_widgets;')
    expect(findings.some((f) => /DROP TABLE/i.test(f))).toBe(true)
  })

  it('flags RENAME COLUMN', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE users RENAME COLUMN email TO email_address;'
    )
    expect(findings.some((f) => /RENAME COLUMN/i.test(f))).toBe(true)
  })

  it('flags table RENAME TO', () => {
    const findings = findDestructiveStatements('ALTER TABLE users RENAME TO accounts;')
    expect(findings.some((f) => /RENAME TO/i.test(f))).toBe(true)
  })

  it('flags TRUNCATE', () => {
    const findings = findDestructiveStatements('TRUNCATE TABLE sessions;')
    expect(findings.some((f) => /TRUNCATE/i.test(f))).toBe(true)
  })

  it('flags bare DELETE FROM', () => {
    const findings = findDestructiveStatements("DELETE FROM settings WHERE key = 'stale';")
    expect(findings.some((f) => /DELETE FROM/i.test(f))).toBe(true)
  })

  it('flags DROP CONSTRAINT', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE projects DROP CONSTRAINT projects_slug_unique;'
    )
    expect(findings.some((f) => /DROP CONSTRAINT/i.test(f))).toBe(true)
  })

  it('flags DROP DEFAULT', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE projects ALTER COLUMN tags DROP DEFAULT;'
    )
    expect(findings.some((f) => /DROP DEFAULT/i.test(f))).toBe(true)
  })

  it('flags ALTER COLUMN ... TYPE, including safe-looking widening changes (conservative by design)', () => {
    const narrowing = findDestructiveStatements(
      'ALTER TABLE credentials ALTER COLUMN name TYPE varchar(10);'
    )
    expect(narrowing.some((f) => /ALTER COLUMN.*TYPE/i.test(f))).toBe(true)

    const widening = findDestructiveStatements(
      'ALTER TABLE credentials ALTER COLUMN name TYPE varchar(200);'
    )
    expect(widening.some((f) => /ALTER COLUMN.*TYPE/i.test(f))).toBe(true)
  })

  it('flags ALTER COLUMN ... TYPE on a quoted identifier containing non-word characters (regression, code review)', () => {
    // A bare `"?[\w]+"?` identifier pattern cannot match a quoted Postgres identifier containing
    // a hyphen, space, or other non-word character — it silently fails to match anywhere in the
    // statement, letting the TYPE change through undetected. Postgres freely allows such
    // identifiers when quoted, so this is a real bypass, not a hypothetical.
    const hyphenated = findDestructiveStatements(
      'ALTER TABLE metrics ALTER COLUMN "risk-score" TYPE integer;'
    )
    expect(hyphenated.some((f) => /ALTER COLUMN.*TYPE/i.test(f))).toBe(true)

    const spaced = findDestructiveStatements(
      'ALTER TABLE metrics ALTER COLUMN "column with spaces" TYPE text;'
    )
    expect(spaced.some((f) => /ALTER COLUMN.*TYPE/i.test(f))).toBe(true)
  })

  it('finds a statement following a double-quoted identifier containing "--" (regression, edge-case review)', () => {
    // A double-quoted identifier is not tracked as its own token, so an embedded "--" inside it
    // was previously misinterpreted by the line-comment scanner as a real comment opener,
    // masking everything through end-of-line — including a real destructive statement on the
    // same line — and silently swallowing it.
    const findings = findDestructiveStatements(
      'ALTER TABLE users RENAME COLUMN "note--legacy" TO note; DROP TABLE secrets;'
    )
    expect(findings.some((f) => /RENAME COLUMN/i.test(f))).toBe(true)
    expect(findings.some((f) => /DROP TABLE/i.test(f))).toBe(true)
    expect(findings).toHaveLength(2)
  })

  it('does not flag ALTER COLUMN ... SET NOT NULL (distinct from a TYPE change)', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE refresh_tokens ALTER COLUMN org_id SET NOT NULL;'
    )
    expect(findings).toEqual([])
  })

  it('flags ADD COLUMN ... NOT NULL with no DEFAULT', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE credentials ADD COLUMN "risk_score" integer NOT NULL;'
    )
    expect(findings.some((f) => /ADD COLUMN/i.test(f) && /NOT NULL/i.test(f))).toBe(true)
  })

  it('does not flag ADD COLUMN ... NOT NULL when a DEFAULT is present (either order)', () => {
    const defaultThenNotNull = findDestructiveStatements(
      'ALTER TABLE credentials ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;'
    )
    expect(defaultThenNotNull).toEqual([])

    const notNullThenDefault = findDestructiveStatements(
      'ALTER TABLE credentials ADD COLUMN "risk_score" integer NOT NULL DEFAULT 0;'
    )
    expect(notNullThenDefault).toEqual([])
  })

  it('does not flag bare ADD COLUMN with no NOT NULL', () => {
    const findings = findDestructiveStatements('ALTER TABLE credentials ADD COLUMN "notes" text;')
    expect(findings).toEqual([])
  })

  it('does not flag an identifier substring that merely contains a destructive keyword', () => {
    const findings = findDestructiveStatements('ALTER TABLE users ADD COLUMN "renamed_email" text;')
    expect(findings).toEqual([])
  })

  it('does not flag a destructive keyword appearing only inside a line comment', () => {
    const findings = findDestructiveStatements(
      '-- TODO: consider a future DROP COLUMN cleanup of this deprecated field\nSELECT 1;'
    )
    expect(findings).toEqual([])
  })

  it('does not flag a destructive keyword appearing only inside a block comment', () => {
    const findings = findDestructiveStatements(
      '/* DROP TABLE reminder: revisit this later */\nSELECT 1;'
    )
    expect(findings).toEqual([])
  })

  it('does not flag a destructive keyword appearing only inside a string literal', () => {
    const findings = findDestructiveStatements(
      "UPDATE settings SET value = 'legacy DROP COLUMN behavior disabled' WHERE key = 'flag';"
    )
    expect(findings).toEqual([])
  })

  it('flags a destructive keyword inside a dollar-quoted block (regression, edge-case review)', () => {
    // A dollar-quoted region is executable PLpgSQL when it's a DO/CREATE FUNCTION body, not
    // inert string data — a naive implementation that masks all dollar-quoted content wholesale
    // (matching single-quoted-string handling) lets a destructive statement wrapped in one bypass
    // this guard entirely. Deliberately conservative (module design): dollar-quoted *data*
    // strings that happen to contain a matching keyword substring will now also be flagged, which
    // is an acceptable false positive for a fail-closed guard.
    const doBlock = findDestructiveStatements('DO $$ BEGIN DROP TABLE credentials; END $$;')
    expect(doBlock.some((f) => /DROP TABLE/i.test(f))).toBe(true)

    const createFunction = findDestructiveStatements(
      'CREATE FUNCTION purge() RETURNS void AS $$ BEGIN TRUNCATE sessions; END $$ LANGUAGE plpgsql;'
    )
    expect(createFunction.some((f) => /TRUNCATE/i.test(f))).toBe(true)
  })

  it('still strips nested comments and string literals inside a dollar-quoted block', () => {
    const findings = findDestructiveStatements(
      'DO $$ BEGIN -- TODO: consider a future DROP TABLE cleanup\n' +
        "PERFORM set_config('app.note', 'a DROP TABLE mention inside a string', true); END $$;"
    )
    expect(findings).toEqual([])
  })

  it('resumes correctly after a dollar-quoted block, finding a destructive statement that follows it', () => {
    const findings = findDestructiveStatements(
      "DO $$ BEGIN PERFORM 1; -- don't touch this\nEND $$;\nDROP TABLE legacy_widgets;"
    )
    expect(findings.some((f) => /DROP TABLE/i.test(f))).toBe(true)
    expect(findings).toHaveLength(1)
  })

  it('still flags a genuine destructive statement alongside an unrelated comment mentioning the same keyword', () => {
    const findings = findDestructiveStatements(
      '-- TODO: consider a future DROP COLUMN cleanup of this deprecated field\nALTER TABLE credentials DROP COLUMN legacy_field;'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatch(/DROP COLUMN/i)
  })

  it('returns an empty array for a purely additive migration', () => {
    const findings = findDestructiveStatements(
      'ALTER TABLE credentials ADD COLUMN "tags" text[] DEFAULT \'{}\';\nCREATE INDEX idx_x ON credentials (tags);'
    )
    expect(findings).toEqual([])
  })

  it('reports a 1-based line number for a match on a later line', () => {
    const findings = findDestructiveStatements(
      'SELECT 1;\nSELECT 2;\nALTER TABLE credentials DROP COLUMN notes;'
    )
    expect(findings[0]).toMatch(/line 3/)
  })
})
