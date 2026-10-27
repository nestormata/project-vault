/**
 * @pv-guard repeated-static-ids
 *
 * Story 63-5 (epic 63 retro Finding 3): markup that renders more than once per page carries no
 * literal id and no literal id reference, so rows never share an id (DW-611, and the 19-3 project
 * tags help before it). The rule is in `repeated-static-ids.ts`.
 */
import { describe, expect, it } from 'vitest'
import { assertNotVacuous, guardSources, readGuardSource } from '../test/guard-root.js'
import { repeatedStaticIds } from './repeated-static-ids.js'

function scan(files: Record<string, string>): string[] {
  return repeatedStaticIds(new Map(Object.entries(files))).map(
    (finding) => `${finding.file}:${finding.line} ${finding.attribute}="${finding.value}"`
  )
}

const ITEMS = '<script>let { items } = $props()</script>\n'

describe('repeated static ids (Story 63-5)', () => {
  it.each([
    ['an interpolated id in a loop', `{#each items as item}<p id={\`h-\${item.id}\`}>x</p>{/each}`],
    [
      'a mixed text and expression id in a loop',
      '{#each items as item}<p id="h-{item.id}">x</p>{/each}',
    ],
    ['a literal id outside any loop', '<p id="h">x</p>'],
    [
      'a literal id in the {:else} of a loop',
      '{#each items as item}<p>{item}</p>{:else}<p id="h">none</p>{/each}',
    ],
    [
      'a literal reference in a loop to one shared id rendered once',
      '{#each items as item}<input aria-describedby="h" />{/each}<p id="h">help</p>',
    ],
  ])('accepts %s', (_label, markup) => {
    expect(scan({ 'src/A.svelte': ITEMS + markup })).toEqual([])
  })

  it.each([
    ['a literal id', '{#each items as item}<p id="h">x</p>{/each}', ['src/A.svelte:2 id="h"']],
    [
      'a literal reference and its target',
      '{#each items as item}<input aria-describedby="h" /><p id="h">x</p>{/each}',
      ['src/A.svelte:2 aria-describedby="h"', 'src/A.svelte:2 id="h"'],
    ],
    [
      'a literal for',
      '{#each items as item}<label for="f">x</label>{/each}',
      ['src/A.svelte:2 for="f"'],
    ],
    [
      'a string-literal expression id',
      "{#each items as item}<p id={'h'}>x</p>{/each}",
      ['src/A.svelte:2 id="h"'],
    ],
    [
      'a literal id prop on a component',
      '{#each items as item}<FormHelpText id="h" />{/each}',
      ['src/A.svelte:2 id="h"'],
    ],
    [
      'a literal id in a nested loop',
      '{#if items}{#each items as item}<div>{#if item}<p id="h">x</p>{/if}</div>{/each}{/if}',
      ['src/A.svelte:2 id="h"'],
    ],
    [
      'a snippet rendered inside a loop',
      '{#snippet row()}<p id="h">x</p>{/snippet}{#each items as item}{@render row()}{/each}',
      ['src/A.svelte:2 id="h"'],
    ],
    [
      'a snippet rendered twice',
      '{#snippet row()}<p id="h">x</p>{/snippet}{@render row()}{@render row?.()}',
      ['src/A.svelte:2 id="h"'],
    ],
  ])('fails on %s in repeated markup (red fixture)', (_label, markup, expected) => {
    expect(scan({ 'src/A.svelte': ITEMS + markup })).toEqual(expected)
  })

  it('accepts a snippet rendered once, and a component rendered in exclusive branches', () => {
    expect(
      scan({
        'src/A.svelte': '{#snippet row()}<p id="h">x</p>{/snippet}{@render row()}',
        'src/B.svelte':
          "<script>import C from './C.svelte'</script>{#if a}<C />{:else if b}<C />{:else}<C />{/if}" +
          '{#await p}<D />{:then}<C2 />{/await}',
        'src/C.svelte': '<p id="c">x</p>',
      })
    ).toEqual([])
  })

  it('follows components rendered in a loop, transitively, through $lib and relative imports', () => {
    const findings = repeatedStaticIds(
      new Map([
        [
          'src/routes/+page.svelte',
          "<script>import Row from '$lib/components/Row.svelte'</script>\n{#each rows as row}<Row {row} />{/each}",
        ],
        [
          'src/lib/components/Row.svelte',
          "<script>import Help from './forms/Help.svelte'</script><Help />",
        ],
        ['src/lib/components/forms/Help.svelte', '<p id="row-help">x</p>'],
        ['src/lib/components/Other.svelte', '<p id="other">once</p>'],
      ])
    )
    expect(findings).toEqual([
      {
        file: 'src/lib/components/forms/Help.svelte',
        line: 1,
        attribute: 'id',
        value: 'row-help',
        reason:
          'rendered by src/lib/components/Row.svelte:1, which is rendered by ' +
          'src/routes/+page.svelte:2 inside the {#each} at line 2',
      },
    ])
  })

  it('fails on a component one file renders twice outside exclusive branches (red fixture)', () => {
    const findings = repeatedStaticIds(
      new Map([
        ['src/P.svelte', "<script>import C from './C.svelte'</script>\n<C />\n{#if a}<C />{/if}"],
        ['src/C.svelte', '<p id="c">x</p>'],
      ])
    )
    expect(findings.map((finding) => finding.reason)).toEqual([
      'rendered twice by src/P.svelte (lines 2, 3)',
    ])
  })

  it('ignores imports it cannot resolve and components outside the scanned tree', () => {
    expect(
      scan({
        'src/A.svelte':
          "<script>import X from 'some-package/X.svelte'; import Y from './Missing.svelte'</script>" +
          '{#each items as i}<X /><Y />{/each}',
      })
    ).toEqual([])
  })

  it('holds for every Svelte component in the tree under test (PV src, or a composed app root)', () => {
    const sources = guardSources(/\.svelte$/)
    assertNotVacuous(sources)
    const findings = repeatedStaticIds(
      new Map(sources.map((source) => [source.path, readGuardSource(source)]))
    ).map(
      (finding) =>
        `${finding.file}:${finding.line}: literal ${finding.attribute}="${finding.value}" ` +
        `renders more than once per page (${finding.reason}); derive it from the item key`
    )
    expect(findings, findings.join('\n')).toEqual([])
  })
})
