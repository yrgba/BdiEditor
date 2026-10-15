// `.sxi` (Palm skin) export.
//
// Ports `PalmSkinConverter.convertSkin` from the Swift reference: the archive payload is
// mirrored into the converter's temporary input folder, the INI/CSS/plist resources are
// parsed into Palm's `PalmSkin` model tree, and the result is repacked as `skin.json`,
// `info.json`, the bundled `native.layout` and the surviving resource files.
//
// Deliberate differences from the Swift tool:
// - `i` (the Info.txt URL) uses the archive's canonical relative path instead of the
//   exporter's absolute temporary path, so the output is machine independent.
// - `dir`/`root` stay empty, `platform` is always "ia", `tool_version` is 3 and
//   `layoutSupport` is true (BdiEditor ships no converter config).
// - "B<x>" button shorthands resolve in `SkinButtonType` order; the Swift build depends on
//   dictionary ordering there and is not reproducible.
// - Zip entries are written in sorted converter-relative order and emptied directories keep
//   an explicit entry, matching the layout the Palm app expects.
// - A BDA source goes through `bdaSkinArchive` first: single-theme BDA packages (`SkinPath`
//   only treats `light`/`dark` as optional extra themes) collapse onto the archive root, so the
//   export keeps one set of paths and never grows a night skin the package does not have.

import { zipSync } from "fflate"
import type { SkinArchive } from "../skin.ts"
import { buildAnimationWrap } from "./palm-animation.ts"
import { insetsJson, rectJson, indexKey, sectionsOf, stripExtension, type ExportContext, type Ini } from "./palm-context.ts"
import { NATIVE_LAYOUT_JSON } from "./palm-native-layout.ts"
import {
  decodeSkinText,
  toBool,
  toDouble,
  toDoubleArray,
  toInsets,
  toInt,
  toRect,
  type IniSection,
} from "./palm-ini.ts"
import { encodePalmJSON, type PalmJSONValue } from "./palm-json.ts"
import { layoutJson } from "./palm-layout.ts"
import { parseXmlPlist, type PalmPlistValue } from "./palm-plist.ts"
import {
  PalmVirtualRoot,
  comparePalmDirectoryPaths,
  normalizePalmPath,
  palmBaseName,
  palmJoinPath,
} from "./palm-vfs.ts"

export { bdaSkinArchive } from "./palm-bda.ts"

type Json = PalmJSONValue

// `deleteFiles(matchExt:)` from both `PalmSkin.convert` and `PalmSkinConverter`.
const DELETED_EXTENSIONS = new Set(["ini", "pop", "cnd", "css", "txt", "bdi", "til", "plist"])

// `renamePreviewImage` only rewrites `demo.png` directly inside these folders.
const PREVIEW_DIRECTORIES = new Set(["", "dark/", "light/", "dark/skin/", "light/skin/"])

const PREVIEW_PREFIX = "file:///"

type ConverterEntry = {
  path: string
  directory: boolean
  bytes?: Uint8Array
}

type SkinStruct = {
  dir: string
  themeSkinDir: string
  info: string
  land?: string[]
  port?: string[]
  res?: string[]
  portRes?: string[]
  landRes?: string[]
  logo: string[]
}

/* ------------------------------------------------------------------ helpers */

function fileExtension(path: string): string {
  const name = palmBaseName(path)
  const separator = name.lastIndexOf(".")
  return separator <= 0 ? "" : name.slice(separator + 1).toLowerCase()
}

function findResource(res: string[] | undefined, name: string): string | undefined {
  return res?.find((path) => palmBaseName(path) === name)
}

function readResource(context: ExportContext, resource: string[] | undefined, name: string): IniSection[] | undefined {
  const path = findResource(resource, name)
  return path === undefined ? undefined : sectionsOf(context, path)
}

// `SkinTileInfoModel` (`.til` tile maps).
function tileModel(entries: Ini, sectionName: string, alpha: number | undefined): Json {
  return {
    info: toBool(entries["SCALABLE"]),
    alpha: alpha !== undefined ? alpha : toInt(entries["USE_ALPHA"]),
    mode: toInt(entries["TILE_MODE"]),
    t_s: toInt(entries["THEME_SCALE_STYLE"]),
    rect1: rectJson(toRect(entries["SOURCE_RECT"])),
    rect2: rectJson(toRect(entries["INNER_RECT"])),
    insets: insetsJson(toInsets(entries["PADDING"])),
    scale: undefined,
    scales: toDoubleArray(entries["SCALE"]),
    id: sectionName,
  }
}

function tileModels(sections: IniSection[]): Json[] {
  const models: Json[] = []
  let useAlpha: number | undefined
  for (const section of sections) {
    if (section.name === "GLOBAL") {
      const model = tileModel(section.entries, section.name, useAlpha)
      useAlpha = (model as Record<string, Json>).alpha as number | undefined
    } else if (section.name.startsWith("IMG")) {
      models.push(tileModel(section.entries, section.name, useAlpha))
    }
  }
  return models
}

/* -------------------------------------------------------------------- style */

// `SkinInfoModel` ([STYLE*]).
function infoModel(entries: Ini, sectionName: string): Json {
  return {
    f: 0,
    id: sectionName,
    s_1: textStyleModel(entries),
    s_2: imageStyleModel(entries),
    s_3: borderStyleModel(entries),
    s_4: soundStyleModel(entries),
    s_5: animationStyleModel(entries),
  }
}

function textStyleModel(entries: Ini): Json {
  const keys = ["SHOW", "FONT_CLEARTYPE", "FONT_SIZE", "FONT_WEIGHT", "FONT_NAME", "NM_COLOR", "HL_COLOR", "FONT_PATH"]
  if (keys.every((key) => entries[key] === undefined)) return undefined
  const backKeys = ["SHOW", "FONT_CLEARTYPE", "FONT_SIZE", "FONT_WEIGHT", "FONT_NAME", "FONT_PATH"]
  return {
    text: entries["SHOW"],
    c_type: toInt(entries["FONT_CLEARTYPE"]),
    f_s: toDouble(entries["FONT_SIZE"]),
    f_w: toInt(entries["FONT_WEIGHT"]),
    f_n: entries["FONT_NAME"],
    c_normal: entries["NM_COLOR"],
    c_hl: entries["HL_COLOR"],
    file: entries["FONT_PATH"],
    for_back: backKeys.every((key) => entries[key] === undefined),
  }
}

function imageStyleModel(entries: Ini): Json {
  if (entries["NM_IMG"] === undefined && entries["HL_IMG"] === undefined) return undefined
  return { normal: entries["NM_IMG"], hl: entries["HL_IMG"] }
}

function borderStyleModel(entries: Ini): Json {
  const size = toDouble(entries["BORDER_SIZE"])
  if (size === undefined) return undefined
  return { size, color: entries["BORDER_COLOR"] }
}

function soundStyleModel(entries: Ini): Json {
  const path1 = entries["PRESS_SOUND_PATH"]
  const path2 = entries["PANEL_SHOW_SOUND_PATH"]
  const path3 = entries["PANEL_HIDE_SOUND_PATH"]
  if (path1 === undefined && path2 === undefined && path3 === undefined) return undefined
  return { path_1: path1, path_2: path2, path_3: path3 }
}

function animationStyleModel(entries: Ini): Json {
  const press = toInt(entries["PRESS_ANIM"])
  const release = toInt(entries["RELEASE_ANIM"])
  const show = toInt(entries["SHOW_ANIM"])
  const hide = toInt(entries["HIDE_ANIM"])
  const hold = toInt(entries["HOLD_ANIM"])
  if (press === undefined && release === undefined && show === undefined && hold === undefined && hide === undefined) {
    return undefined
  }
  return { "1": press, "2": release, "3": show, "4": hide, "5": hold }
}

// `SkinStyle` (s_info / s_land / s_port).
function styleJson(context: ExportContext, res: string[] | undefined): Json {
  const skinStyles: Record<string, Json> = {}
  const animStyles: Record<string, Json> = {}
  let skinTileMap: Record<string, Json> | undefined

  for (const section of readResource(context, res, "default.css") ?? []) {
    if (!section.name.startsWith("STYLE")) continue
    const index = indexKey(section.name, "STYLE")
    if (index === undefined) continue
    skinStyles[String(index)] = infoModel(section.entries, section.name)
  }

  for (const section of readResource(context, res, "anim.ini") ?? []) {
    if (!section.name.startsWith("ANIM") && !section.name.startsWith("BUILD_NUM")) continue
    const wrap = buildAnimationWrap(section)
    if (wrap === undefined) continue
    const index = indexKey(section.name, "ANIM")
    if (index === undefined) continue
    animStyles[String(index)] = wrap
  }

  if (res !== undefined) {
    const map: Record<string, Json> = {}
    for (const path of res) {
      if (!palmBaseName(path).toLowerCase().endsWith(".til")) continue
      const sections = sectionsOf(context, path)
      if (sections === undefined) continue
      map[stripExtension(path)] = tileModels(sections)
    }
    skinTileMap = map
  }

  return { ss_1: skinStyles, ss_2: animStyles, ss_3: [], ss_4: [], ss_5: [], info: skinTileMap }
}

/* ------------------------------------------------------------------ toolbar */

function toolbarItem(value: PalmPlistValue): Json | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, PalmPlistValue>
  const position = record["Position"]
  const name = record["Name"]
  const titles = record["Titles"]
  const images = record["Images"]
  if (typeof position !== "string" || typeof name !== "string") return undefined
  if (typeof titles !== "object" || titles === null || Array.isArray(titles)) return undefined
  const normalTitle = (titles as Record<string, PalmPlistValue>)["Normal"]
  if (typeof normalTitle !== "object" || normalTitle === null || Array.isArray(normalTitle)) return undefined
  const titleDetail = normalTitle as Record<string, PalmPlistValue>
  if (typeof titleDetail["Normal"] !== "string" || typeof titleDetail["Selected"] !== "string") return undefined
  if (typeof images !== "object" || images === null || Array.isArray(images)) return undefined
  const imageRecord = images as Record<string, PalmPlistValue>
  const normal = imageDetail(imageRecord["Normal"])
  const theme = imageDetail(imageRecord["Theme"])
  if (normal === undefined || theme === undefined) return undefined
  return {
    Position: position,
    Name: name,
    Titles: { Normal: { Normal: titleDetail["Normal"], Selected: titleDetail["Selected"] } },
    Images: { Normal: normal, Theme: theme },
  }
}

function imageDetail(value: PalmPlistValue | undefined): Json | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, PalmPlistValue>
  const normal = record["Normal"]
  if (typeof normal !== "string") return undefined
  const highlight = record["Highlight"]
  const selected = record["Selected"]
  return {
    Normal: normal,
    Highlight: typeof highlight === "string" ? highlight : undefined,
    Selected: typeof selected === "string" ? selected : undefined,
  }
}

function toolbarMenu(context: ExportContext, logo: string[]): Json {
  // `menu` is positional rather than a set, so it has to replay the converter's own
  // directory order instead of the sorted order `childPaths()` hands out elsewhere.
  const paths = logo
    .filter((path) => path.includes("toolbarMenuItems"))
    .sort(comparePalmDirectoryPaths)
  if (paths.length === 0) return undefined
  const result: Json[] = []
  for (const path of paths) {
    const bytes = context.root.bytes(path.slice(1))
    const plist = bytes === undefined ? undefined : parseXmlPlist(bytes)
    if (!Array.isArray(plist)) return undefined
    const items: Json[] = []
    for (const value of plist) {
      const item = toolbarItem(value)
      if (item === undefined) return undefined
      items.push(item)
    }
    result.push(items)
  }
  return result.length === 0 ? undefined : result
}

function menuIcon(context: ExportContext, logo: string[], name: string): Json {
  const path = logo.find((entry) => entry.includes(name))
  if (path === undefined) return undefined
  const sections = sectionsOf(context, path.slice(1))
  return sections === undefined ? undefined : tileModels(sections)
}

/* ------------------------------------------------------------------- struct */

function structModel(context: ExportContext, dir: string): SkinStruct {
  const skinDir = context.root.isDirectory(palmJoinPath(dir, "skin")) ? palmJoinPath(dir, "skin") : dir
  const res = filesPathInDirectory(context.root, palmJoinPath(skinDir, "res"))
  let portRes = filesPathInDirectory(context.root, palmJoinPath(skinDir, "port/res"))
  let landRes = filesPathInDirectory(context.root, palmJoinPath(skinDir, "land/res"))
  if (res !== undefined && res.length > 0) {
    if (portRes !== undefined) portRes = [...portRes, ...res]
    if (landRes !== undefined) landRes = [...landRes, ...res]
  }
  return {
    dir,
    themeSkinDir: skinDir,
    info: palmJoinPath(dir, "Info.txt"),
    land: context.root.filesInDirectory(palmJoinPath(skinDir, "land")),
    port: context.root.filesInDirectory(palmJoinPath(skinDir, "port")),
    res,
    portRes,
    landRes,
    logo: context.root.allFiles(palmJoinPath(skinDir, "res/logo")).map((path) => `/${path}`),
  }
}

// `FileManager.filesPathInDirectory(atURL:rootDir:)`: immediate children relative to root.
function filesPathInDirectory(root: PalmVirtualRoot, folder: string): string[] | undefined {
  if (!root.isDirectory(folder)) return undefined
  return root.childPaths(folder)
}

// `SkinFile.removeUselessPath()`.
function removeUselessPath(res: string[] | undefined): string[] | undefined {
  return res?.filter((path) => !path.endsWith(".til"))
}

function skinFileJson(context: ExportContext, struct: SkinStruct): Json {
  const res = removeUselessPath(struct.res)
  const portRes = removeUselessPath(struct.portRes)
  const landRes = removeUselessPath(struct.landRes)
  const logo = struct.logo.filter((path) => !path.endsWith(".plist"))
  const model: Record<string, Json> = {
    land_layout: layoutJson(context, struct.land),
    port_layout: layoutJson(context, struct.port),
    r_info: res,
    r_logo: logo,
    r_land: landRes,
    r_port: portRes,
    // The converter mirrors its temporary input folder, so `i` stays converter relative.
    i: PREVIEW_PREFIX + struct.info,
    s_info: styleJson(context, struct.res),
    dir: "",
    // `menu`/`a_m`/`a_i` are built during `parseINIFiles`, before `removeUselessPath()`
    // drops the `.plist` entries from `r_logo`, so they see the unfiltered list.
    menu: toolbarMenu(context, struct.logo),
    a_m: menuIcon(context, struct.logo, "pop_menu_icons.til"),
    a_i: menuIcon(context, struct.logo, "pop_input_icons.til"),
  }
  if (struct.portRes !== undefined) model.s_port = styleJson(context, struct.portRes)
  if (struct.landRes !== undefined) model.s_land = styleJson(context, struct.landRes)
  return model
}

/* --------------------------------------------------------------- info.json */

function skinInfoJson(context: ExportContext, infoPath: string): Json {
  const bytes = context.root.bytes(infoPath)
  const text = bytes === undefined ? undefined : decodeSkinText(bytes)
  if (text === undefined) {
    return {
      name: "default",
      description: "",
      author: "",
      platform: "ia",
      tool_version: 3,
      core_ability: 0,
      dark_mode: true,
      layoutSupport: true,
      splitImage: false,
    }
  }
  let name = ""
  let description = ""
  let author = ""
  let darkMode: boolean | undefined
  let ability: number | undefined
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const parts = line.split("=")
    if (parts.length !== 2) continue
    const key = parts[0].trim()
    const value = parts[1].trim()
    if (key === "Name") name = value
    else if (key === "Description") description = value
    else if (key === "Author") author = value
    else if (key === "SupportDarkMode") darkMode = toBool(value) ?? false
    else if (key === "MinImeCode") ability = toInt(value) ?? 0
  }
  return {
    name,
    description,
    author,
    platform: "ia",
    tool_version: 3,
    core_ability: ability ?? 0,
    dark_mode: darkMode ?? false,
    layoutSupport: true,
    splitImage: false,
  }
}

/* ------------------------------------------------------------------- output */

function collectConverterEntries(archive: SkinArchive): ConverterEntry[] {
  const raws = archive.names().map((canonical) => {
    const raw = archive.sourcePath(canonical)
    return { canonical, raw, normalized: normalizePalmPath(raw), directory: raw.endsWith("/") }
  })
  const usesSkinRoot = raws.some(({ normalized }) => normalized === "skin" || normalized.startsWith("skin/"))
  const entries: ConverterEntry[] = []
  for (const item of raws) {
    let path = item.normalized
    if (usesSkinRoot) {
      if (!path.startsWith("skin/")) continue
      path = path.slice("skin/".length)
    }
    if (!path) continue
    entries.push({
      path,
      directory: item.directory,
      bytes: item.directory ? undefined : archive.getBytes(item.canonical),
    })
  }
  return entries
}

// Folders that survive the deletion passes with no file left inside them still need an
// explicit zip entry: the real `.sxi` keeps, for example, `light/skin/land/`.
function emptyDirectories(entries: ConverterEntry[], written: Iterable<string>): string[] {
  const directories = new Set<string>()
  for (const entry of entries) {
    const parts = entry.path.split("/")
    const parentParts = entry.directory ? parts : parts.slice(0, -1)
    let parent = ""
    for (const part of parentParts) {
      parent = parent ? `${parent}/${part}` : part
      directories.add(parent)
    }
  }
  const populated = new Set<string>()
  for (const path of written) {
    const parts = path.split("/")
    let current = ""
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part
      populated.add(current)
    }
  }
  return [...directories].filter((directory) => !populated.has(directory)).sort()
}

export function buildSxiZip(archive: SkinArchive): { bytes: Uint8Array; warnings: string[] } {
  if (archive.format === "bda") {
    // BDA packages carry protobuf panels instead of an INI layout tree, so a caller that
    // reaches this point must go through `bdaSkinArchive` first.
    throw new Error("BDA 皮肤需要先转换为 BDI/BDS 布局再导出手心皮肤（.sxi）")
  }

  const entries = collectConverterEntries(archive)
  const warnings: string[] = []
  const context: ExportContext = {
    root: new PalmVirtualRoot(entries.map((entry) => ({ path: entry.path, bytes: entry.bytes }))),
    warnings,
    sections: new Map(),
  }

  const skinDir = context.root.isDirectory("skin") ? "skin" : ""
  const infoPath = palmJoinPath(skinDir, "Info.txt")
  const lightStruct = structModel(context, palmJoinPath(skinDir, "light"))
  const darkStruct = structModel(context, palmJoinPath(skinDir, "dark"))
  const hasLight = context.root.isDirectory(palmJoinPath(skinDir, "light"))
  const hasDark = context.root.isDirectory(palmJoinPath(skinDir, "dark"))

  const skin: Record<string, Json> = {
    root: "",
    default: skinFileJson(context, hasLight ? lightStruct : structModel(context, skinDir)),
    night: hasDark ? skinFileJson(context, darkStruct) : undefined,
    info: skinInfoJson(context, infoPath),
    demo: undefined,
  }

  const files: Record<string, Uint8Array> = {
    "skin.json": new TextEncoder().encode(encodePalmJSON(skin)),
    "info.json": new TextEncoder().encode(encodePalmJSON(skinJsonInfo(skin))),
  }
  const written = new Set<string>()
  for (const entry of entries) {
    if (entry.directory) continue
    if (DELETED_EXTENSIONS.has(fileExtension(entry.path))) continue
    const preview = previewPath(entry.path)
    const name = preview !== undefined && files[preview] === undefined ? preview : entry.path
    files[name] = entry.bytes ?? new Uint8Array()
    written.add(name)
  }
  for (const directory of emptyDirectories(entries, written)) {
    files[`${directory}/`] = new Uint8Array()
  }

  // `copyLayoutIfNeed` copies the bundled `native_325.json` into the output folder so a
  // standalone skin can resolve its `native` specify-layout. The Swift call is `try?`, so a
  // source file already named `native.layout` survives untouched.
  if (files["native.layout"] === undefined) {
    files["native.layout"] = new TextEncoder().encode(NATIVE_LAYOUT_JSON)
  }

  return { bytes: zipSync(files, { level: 6 }), warnings }
}

function skinJsonInfo(skin: Record<string, Json>): Json {
  return skin.info
}

function previewPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/")
  const parent = separator < 0 ? "" : path.slice(0, separator + 1)
  if (path.slice(parent.length) !== "demo.png") return undefined
  return PREVIEW_DIRECTORIES.has(parent) ? `${parent}preview.png` : undefined
}
