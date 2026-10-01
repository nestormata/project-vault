# @project-vault/extension-api public type surface

Generated from `src/index.ts`; update this file and classify the change against the policy when the contract changes.

## export `Both`

- since: 1.0.0
- kind: type
- type: `Both`
- intersection-members: `Left`, `Right`

## export `Chain`

- since: 1.0.0
- kind: type
- type: `Chain`
- member: `head`
  - since: 1.0.0
  - type: `Chain`
- member: `next?`
  - since: 1.0.0
  - type: `Chain | undefined`
  - union-members: `undefined`, `Chain`
- member: `value`
  - since: 1.0.0
  - type: `number`

## export `Choice`

- since: 1.0.0
- kind: type
- type: `Choice`
- union-members: `"a"`, `"b"`

## export `greet`

- since: 1.0.0
- kind: value
- type: `(name: string) => string`
- call-signature: `(name: string): string`

## export `Left`

- since: 1.0.0
- kind: type
- type: `Left`
- member: `left`
  - since: 1.0.0
  - type: `string`

## export `Probe`

- since: 1.0.0
- kind: type
- type: `Probe`
- member: `readonly id`
  - type: `string`
- member: `list`
  - since: 1.0.0
  - type: `string[]`
- member: `pair`
  - since: 1.0.0
  - type: `[string, number]`
- member: `run`
  - since: 1.0.0
  - type: `() => void`
  - call-signature: `(): void`
- member: `tags?`
  - since: 1.0.0
  - type: `string[] | undefined`
  - union-members: `undefined`, `string[]`
- index-signature: `[string]: unknown`
  - since: 1.0.0

## export `Right`

- since: 1.0.0
- kind: type
- type: `Right`
- member: `right`
  - since: 1.0.0
  - type: `number`
