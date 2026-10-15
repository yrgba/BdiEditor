import { decodeSkinText, parseIniSections, toInt, type IniSection, type PalmInsets } from "./palm-ini.ts"
import type { PalmJSONValue } from "./palm-json.ts"
import { palmBaseName, type PalmVirtualRoot } from "./palm-vfs.ts"

type Json = PalmJSONValue
export type Ini = Record<string, string>

export type ExportContext = {
  root: PalmVirtualRoot
  warnings: string[]
  sections: Map<string, IniSection[] | undefined>
}

export function stripExtension(path: string): string {
  const name = palmBaseName(path)
  const separator = name.lastIndexOf(".")
  return separator <= 0 ? name : name.slice(0, separator)
}

export function rectJson(value: [[number, number], [number, number]] | undefined): Json {
  return value === undefined ? undefined : [[value[0][0], value[0][1]], [value[1][0], value[1][1]]]
}

export function insetsJson(value: PalmInsets | undefined): Json {
  return value === undefined
    ? undefined
    : { top: value.top, left: value.left, bottom: value.bottom, right: value.right }
}

export function indexKey(sectionName: string, prefix: string): number | undefined {
  return toInt(sectionName.split(prefix).join(""))
}

/* --------------------------------------------------------------- ini access */

export function sectionsOf(context: ExportContext, path: string): IniSection[] | undefined {
  if (context.sections.has(path)) return context.sections.get(path)
  const bytes = context.root.bytes(path)
  let sections: IniSection[] | undefined
  if (bytes !== undefined) {
    const text = decodeSkinText(bytes)
    if (text === undefined) {
      context.warnings.push(`无法解析文本文件：${path}`)
    } else {
      sections = parseIniSections(text)
    }
  }
  context.sections.set(path, sections)
  return sections
}
