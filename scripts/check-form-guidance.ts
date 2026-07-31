#!/usr/bin/env tsx
/**
 * G5 static guard: every rendered user-facing native form control must expose a
 * visible description through aria-describedby. This is intentionally a small
 * Svelte-aware scanner rather than a formatter or a general HTML validator.
 * It reports source locations so a reviewer can inspect each result.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { toRepoPath, walkFiles } from './lib/scan-utils.js'

export type FormGuidanceFinding = {
  file: string
  line: number
  kind: 'missing-description' | 'missing-description-target' | 'duplicate-description-id'
  control?: string
  descriptionId?: string
  message: string
}

type NativeControl = {
  tag: string
  attrs: string
  offset: number
  line: number
  type: string
  descriptionIds: string[]
}

type ElementId = { id: string; tag: string; line: number }

function maskNonTemplate(source: string): string {
  return source.replace(
    /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\b[^>]*>|<style\b[\s\S]*?<\/style\b[^>]*>/gi,
    (region) => region.replace(/[^\n]/g, ' ')
  )
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split(/\r?\n/).length
}

function readQuotedAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*[\\"']([^\\"']*)[\\"']`, 'i')
  return pattern.exec(attrs)?.[1]
}

function readDescriptionIds(attrs: string): string[] {
  const value = readQuotedAttribute(attrs, 'aria-describedby')
  if (value !== undefined) return value.split(/\s+/).filter(Boolean)
  return /\baria-describedby\s*=/.test(attrs) ? ['__dynamic_description__'] : []
}

type TagScanState = { quote: '"' | "'" | undefined; braces: number; end: boolean }

function advanceTagScan(source: string, index: number, state: TagScanState): TagScanState {
  const char = source[index]
  if (state.quote) {
    return char === state.quote && source[index - 1] !== '\\'
      ? { ...state, quote: undefined }
      : state
  }
  if (char === '"' || char === "'") return { ...state, quote: char }
  if (char === '{') return { ...state, braces: state.braces + 1 }
  if (char === '}') return { ...state, braces: Math.max(0, state.braces - 1) }
  return char === '>' && state.braces === 0 ? { ...state, end: true } : state
}

function findTagEnd(source: string, start: number): number {
  let state: TagScanState = { quote: undefined, braces: 0, end: false }
  for (let index = start; index < source.length; index += 1) {
    state = advanceTagScan(source, index, state)
    if (state.end) return index
  }
  return -1
}

function extractControls(source: string): NativeControl[] {
  const masked = maskNonTemplate(source)
  const controls: NativeControl[] = []
  const startPattern = /<(input|select|textarea)(?=\s|\/?>)/gi

  for (const match of masked.matchAll(startPattern)) {
    const offset = match.index ?? 0
    const end = findTagEnd(masked, offset + match[0].length)
    if (end < 0) continue

    const tag = match[1].toLowerCase()
    const attrs = masked.slice(offset + match[0].length, end)
    const type = readQuotedAttribute(attrs, 'type')?.toLowerCase() ?? 'text'
    if (tag === 'input' && type === 'hidden') continue

    controls.push({
      tag,
      attrs,
      offset,
      line: lineAt(source, offset),
      type,
      descriptionIds: readDescriptionIds(attrs),
    })
  }
  return controls
}

function extractStaticIds(source: string): ElementId[] {
  const masked = maskNonTemplate(source)
  const ids: ElementId[] = []
  const idPattern =
    /<(?!input\b|select\b|textarea\b)([a-z][\w:-]*|FormHelpText)\b[^>]*\bid\s*=\s*["']([^"']+)["']/g
  for (const match of masked.matchAll(idPattern)) {
    const offset = match.index ?? 0
    ids.push({ id: match[2], tag: match[1].toLowerCase(), line: lineAt(source, offset) })
  }
  return ids
}

function controlName(control: NativeControl): string {
  const id = readQuotedAttribute(control.attrs, 'id')
  return `${control.tag}${id ? `#${id}` : `[${control.type}]`}`
}

function indexStaticIds(ids: ElementId[]): Map<string, ElementId[]> {
  const idsByName = new Map<string, ElementId[]>()
  for (const element of ids) {
    const entries = idsByName.get(element.id) ?? []
    entries.push(element)
    idsByName.set(element.id, entries)
  }
  return idsByName
}

function findControlFindings(
  controls: NativeControl[],
  idsByName: Map<string, ElementId[]>,
  file: string
): FormGuidanceFinding[] {
  const findings: FormGuidanceFinding[] = []
  for (const control of controls) {
    const name = controlName(control)
    if (control.descriptionIds.length === 0) {
      findings.push({
        file,
        line: control.line,
        kind: 'missing-description',
        control: name,
        message: `${name} needs visible help text referenced by aria-describedby`,
      })
      continue
    }

    for (const descriptionId of control.descriptionIds) {
      if (descriptionId === '__dynamic_description__' || idsByName.has(descriptionId)) continue
      findings.push({
        file,
        line: control.line,
        kind: 'missing-description-target',
        control: name,
        descriptionId,
        message: `${name} references missing description #${descriptionId}`,
      })
    }
  }
  return findings
}

function findDuplicateFindings(
  controls: NativeControl[],
  idsByName: Map<string, ElementId[]>,
  file: string
): FormGuidanceFinding[] {
  const findings: FormGuidanceFinding[] = []
  for (const [id, elements] of idsByName) {
    if (elements.length < 2 || !controls.some((control) => control.descriptionIds.includes(id)))
      continue
    for (const duplicate of elements.slice(1)) {
      findings.push({
        file,
        line: duplicate.line,
        kind: 'duplicate-description-id',
        descriptionId: id,
        message: `description #${id} is rendered more than once in this component`,
      })
    }
  }
  return findings
}

export function scanFormGuidance(source: string, file = '<source>'): FormGuidanceFinding[] {
  const controls = extractControls(source)
  const idsByName = indexStaticIds(extractStaticIds(source))
  return [
    ...findControlFindings(controls, idsByName, file),
    ...findDuplicateFindings(controls, idsByName, file),
  ].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
}

export function scanWebFormGuidance(rootDir = process.cwd()): FormGuidanceFinding[] {
  const root = resolve(rootDir)
  const sourceDir = resolve(root, 'apps/web/src')
  return walkFiles(sourceDir, (file) => file.endsWith('.svelte')).flatMap((absolute) => {
    const file = toRepoPath(root, absolute)
    return scanFormGuidance(readFileSync(absolute, 'utf8'), file)
  })
}

function main(): void {
  const findings = scanWebFormGuidance()
  for (const finding of findings) {
    process.stdout.write(
      `[MISSING] ${finding.kind} ${finding.file}:${finding.line}\n` + `  ${finding.message}\n`
    )
  }
  process.stdout.write(`check-form-guidance: ${findings.length} finding(s)\n`)
  if (findings.length > 0) process.exitCode = 1
}

if (basename(process.argv[1] ?? '') === 'check-form-guidance.ts') main()
