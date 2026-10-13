/**
 * Story 71.5 AC-1: the guard that keeps the e2e delegation test signer (kid, instance id, public
 * key) out of every production-facing file. Pure over `{ path, text }` pairs so a test can plant
 * each marker and prove the guard goes red; `scripts/e2e-stack.test.ts` feeds it the real files.
 */

export type GuardFile = { path: string; text: string }
export type GuardMarker = { label: string; value: string }

/** The base64 body of a PEM public key, so the key cannot be copied in under another kid. */
export function pemBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s/g, '')
}

/** One message per (file, marker) pair where the file contains the marker. */
export function findDelegationTestKeyLeaks(
  files: readonly GuardFile[],
  markers: readonly GuardMarker[]
): string[] {
  return files.flatMap((file) =>
    markers
      .filter((marker) => marker.value.length > 0 && file.text.includes(marker.value))
      .map((marker) => `${file.path} contains the ${marker.label}`)
  )
}
