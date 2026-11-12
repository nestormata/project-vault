// One HTML-entity decode pass for brand-name HTML/SVG text. Named refs that are
// not in this map stay as source text. Numeric refs outside Unicode become U+FFFD.
const NAMED = new Map<string, string>([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['quot', '"'],
  ['nbsp', '\u00a0'],
  ['NonBreakingSpace', '\u00a0'],
  ['NewLine', '\n'],
  ['Tab', '\t'],
  ['ensp', '\u2002'],
  ['emsp', '\u2003'],
  ['emsp13', '\u2004'],
  ['emsp14', '\u2005'],
  ['numsp', '\u2007'],
  ['puncsp', '\u2008'],
  ['thinsp', '\u2009'],
  ['hairsp', '\u200A'],
  ['mediumsp', '\u205F'],
  ['zwnj', '\u200C'],
  ['zwj', '\u200D'],
  ['lrm', '\u200E'],
  ['rlm', '\u200F'],
  ['shy', '\u00AD'],
])

const ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/g

function decodeCodePoint(value: number): string {
  const invalid =
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  return invalid ? '\uFFFD' : String.fromCodePoint(value)
}

function replacement(
  match: string,
  hex: string | undefined,
  dec: string | undefined,
  name: string | undefined
): string {
  if (hex !== undefined) return decodeCodePoint(Number.parseInt(hex, 16))
  if (dec !== undefined) return decodeCodePoint(Number.parseInt(dec, 10))
  if (name === undefined) return match
  return NAMED.get(name) ?? match
}

export function decodeHtmlEntities(source: string): string {
  return source.replace(ENTITY, replacement)
}
