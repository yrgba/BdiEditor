import { boardTypeFromIniCode, boardTypeFromIniFileName } from "./palm-board-types.ts"
import { insetsJson, rectJson, indexKey, sectionsOf, stripExtension, type ExportContext, type Ini } from "./palm-context.ts"
import { actionCode, toBool, toCharacters, toDouble, toInsets, toInt, toIntArray, toLastInt, toPoint, toRect, stripSpaces, toTipsMap } from "./palm-ini.ts"
import type { PalmJSONValue } from "./palm-json.ts"
import { fixTouchRects } from "./palm-touch-rect.ts"
import { palmBaseName, palmJoinPath } from "./palm-vfs.ts"

type Json = PalmJSONValue

function unique(values: number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

// CoreGraphics values encode as nested arrays: points as `[x, y]`, rects as
// `[[x, y], [w, h]]`.
function pointJson(value: [number, number] | undefined): Json {
  return value === undefined ? undefined : [value[0], value[1]]
}

// `SkinButtonType`, in declaration order. The order is what makes the "B<x>" shorthand
// deterministic: Swift iterates a dictionary there.
const BUTTON_TYPES: Array<[number, string]> = [
  [0, "UP"],
  [1, "DOWN"],
  [2, "LEFT"],
  [3, "RIGHT"],
  [4, "CENTER"],
  [5, "SHOW"],
  [6, "HOLD"],
  [7, "HOLDSYM"],
  [8, "BAR_SYM"],
  [9, "BAR_SYM_SEL"],
]

const SHOW_TYPE = 5

function buttonValues(entries: Ini): Array<[number, string]> {
  const resolved: Array<string | undefined> = new Array(BUTTON_TYPES.length).fill(undefined)
  for (const [type, iniKey] of BUTTON_TYPES) {
    const raw = entries[iniKey]
    if (raw === undefined) continue
    resolved[type] = actionCode(raw) ?? raw
  }
  for (const [type] of BUTTON_TYPES) {
    const value = resolved[type]
    if (value === undefined || value.length !== 2 || !value.startsWith("B")) continue
    resolved[type] = value.replace(/B/g, "")
    resolved[SHOW_TYPE] = resolved[type]
  }
  const result: Array<[number, string]> = []
  for (const [type] of BUTTON_TYPES) {
    const value = resolved[type]
    if (value !== undefined) result.push([type, value])
  }
  return result
}

// `SkinButtonType.valueMapFrom` never returns nil, and both encoders open a nested
// unkeyed container unconditionally, so an empty map still writes `[]`.
function valuesJson(pairs: Array<[number, string]>): Json {
  const flat: Array<number | string> = []
  for (const [type, value] of pairs) {
    flat.push(type, value)
  }
  return flat
}

/* ------------------------------------------------------------------- models */

// `SkinBaseModel.init(entries:)`.
function baseModel(entries: Ini): Json {
  const foreStyle = entries["FORE_STYLE"] === undefined ? undefined : unique(toIntArray(entries["FORE_STYLE"]))
  const offsets = entries["POS_TYPE"] === undefined ? undefined : toIntArray(entries["POS_TYPE"])
  return {
    base_b: toInt(entries["BACK_STYLE"]),
    base_f: foreStyle,
    base_s: toInt(entries["SOUND_STYLE"]),
    asi: toLastInt(entries["ANIM_STYLE"]),
    base_ba: toInt(entries["BACK_ANIM_STYLE"]),
    base_o: offsets === undefined ? undefined : offsets.slice(0, foreStyle?.length ?? 0),
    base_pa: toInt(entries["PANEL_ANIM_STYLE"]),
    base_fa: entries["FORE_ANIM_STYLE"] === undefined ? undefined : toIntArray(entries["FORE_ANIM_STYLE"]),
    base_a: toLastInt(entries["FORE_ANIM_STYLE"]),
  }
}

function constModel(entries: Ini): Json {
  return { s_full: toBool(entries["SYMBOL_FULL_SCREEN"]) }
}

// `SkinComposeModel` ([INPUT]).
function composeModel(entries: Ini): Json {
  return {
    b: baseModel(entries),
    type: toInt(entries["TYPE"]),
    pos: pointJson(toPoint(entries["POS"])),
    size: pointJson(toPoint(entries["SIZE"])),
    f_size: pointJson(toPoint(entries["FIX_SIZE"])),
    insets: insetsJson(toInsets(entries["PADDING"])),
  }
}

// `SkinCandidateModel.setupWithEntries` ([CAND], shared with `*.cnd`).
function candidateModel(entries: Ini): Record<string, Json> {
  return {
    b: baseModel(entries),
    f_size: pointJson(toPoint(entries["FIX_SIZE"])),
    rect: rectJson(toRect(entries["VIEW_RECT"])),
    insets: insetsJson(toInsets(entries["PADDING"])),
    gap: toDouble(entries["CELL_W"]),
    f_gap: toDouble(entries["FIRST_GAP"]),
    more_width: toDouble(entries["MORE_W"]),
    i_cell: undefined,
    i_mask: toInt(entries["MASK_STYLE"]),
    i_f_b: toInt(entries["FIRST_BACK"]),
    i_f_f: toInt(entries["FIRST_FORE"]),
    switch: undefined,
    icon_list: undefined,
    fix: undefined,
    file: entries["LAYOUT_NAME"],
    i_cand: toIntArray(entries["FORE_STYLE"])[0],
  }
}

// `SkinCandidateModel(fileURL:)` for `*.cnd`.
function candidateModelFromFile(context: ExportContext, path: string): Json {
  const sections = sectionsOf(context, path) ?? []
  const model: Record<string, Json> = { b: undefined, fix: undefined, switch: undefined, icon_list: [] }
  const icons: Json[] = []
  const tips: Record<string, Json> = {}
  for (const section of sections) {
    if (section.name === "CAND") {
      // Keep earlier sections: `setupWithEntries` only owns the keys it writes.
      for (const [key, value] of Object.entries(candidateModel(section.entries))) {
        if (value !== undefined) model[key] = value
      }
    } else if (section.name === "SWITCH") {
      model.switch = candidateSwitchModel(section.entries)
    } else if (section.name.startsWith("ICON")) {
      icons.push(candidateIconModel(section.entries))
    } else if (section.name.startsWith("TIP")) {
      const index = indexKey(section.name, "TIP")
      if (index !== undefined) tips[String(index)] = buttonFixModel(section.entries)
    }
  }
  model.icon_list = icons.some((icon) => (icon as Record<string, Json>).f_size !== undefined) ? icons : []
  // `SkinCandidateModel(fileURL:)` assigns `tips` unconditionally, empty included.
  model.fix = tips
  return model
}

function candidateSwitchModel(entries: Ini): Json {
  return {
    b: baseModel(entries),
    i_normal: toInt(entries["NML_BACK_STYLE"]),
    i_select: toInt(entries["SEL_BACK_STYLE"]),
    i_font: toInt(entries["NML_FONT_STYLE"]),
    i_font_select: toInt(entries["SEL_FONT_STYLE"]),
    insets: toDouble(entries["PADDING"]),
  }
}

function candidateIconModel(entries: Ini): Json {
  const anchor = toInt(entries["ANCHOR_TYPE"]) ?? 4
  return {
    t: toTipsMap(entries["STAT_STYLE"]),
    b: baseModel(entries),
    p: pointJson(toPoint(entries["POS"])),
    s: pointJson(toPoint(entries["SIZE"])),
    k: actionCode(entries["KEY"] ?? ""),
    keep: toInt(entries["PERSIST"]),
    anchor: anchor >= 1 && anchor <= 9 ? anchor : undefined,
    offset: pointJson(toPoint(entries["OFFSET"])),
    f_size: pointJson(toPoint(entries["FIX_SIZE"])),
    hot_fix: toBool(entries["CAN_PATCHED"]),
  }
}

function bubbleIconModel(entries: Ini): Json {
  const anchor = toInt(entries["ANCHOR_TYPE"]) ?? 4
  return {
    b: baseModel(entries),
    anchor: anchor >= 1 && anchor <= 9 ? anchor : undefined,
    i_cell: toInt(entries["CELL_STYLE"]),
    pos: pointJson(toPoint(entries["POS"])),
    size: pointJson(toPoint(entries["SIZE"])),
    c_size: pointJson(toPoint(entries["CELL_SIZE"])),
    insets: insetsJson(toInsets(entries["PADDING"])),
  }
}

// `SkinBubbleModel(entries:)` ([HINT]).
function bubbleModel(entries: Ini): Json {
  return {
    b: baseModel(entries),
    anchor: toInt(entries["ANCHOR_TYPE"]),
    hint: toInt(entries["TYPE"]),
    file: entries["LAYOUT_NAME"],
    bar_a: toInt(entries["FORE_ANIM_STYLE"]),
    info: undefined,
    icon_info: undefined,
    i_cell: undefined,
  }
}

const BUBBLE_TYPES: Array<[number, string]> = [
  [0, "hint"],
  [1, "bar"],
  [2, "up"],
  [3, "down"],
  [4, "left"],
  [5, "right"],
]

// `SkinBubbleModel(fileURL:)` for `*.pop`: the index map is stored as a flat array.
function bubbleModelFromFile(context: ExportContext, path: string): Json {
  const sections = sectionsOf(context, path) ?? []
  const model: Record<string, Json> = {}
  const indexes = new Map<number, number>()
  const icons: Record<string, Json> = {}
  for (const section of sections) {
    const entries = section.entries
    if (section.name === "HINT") {
      const index = toInt(entries["BACK_ICON"])
      if (index !== undefined) indexes.set(0, index)
    } else if (section.name === "DRAW") {
      const up = toInt(entries["ICON_UP"])
      const down = toInt(entries["ICON_DN"])
      const left = toInt(entries["ICON_LT"])
      const right = toInt(entries["ICON_RT"])
      if (up !== undefined) indexes.set(2, up)
      if (down !== undefined) indexes.set(3, down)
      if (left !== undefined) indexes.set(4, left)
      if (right !== undefined) indexes.set(5, right)
    } else if (section.name === "BAR") {
      const index = toInt(entries["BACK_ICON"])
      if (index !== undefined) indexes.set(1, index)
      const cell = toInt(entries["CELL_STYLE"])
      if (cell !== undefined) model.i_cell = cell
    } else if (section.name.startsWith("ICON")) {
      const index = indexKey(section.name, "ICON")
      if (index !== undefined) icons[String(index)] = bubbleIconModel(entries)
    }
  }
  const flat: number[] = []
  for (const [type] of BUBBLE_TYPES) {
    const index = indexes.get(type)
    if (index === undefined) continue
    flat.push(type, index)
  }
  // `SkinBubbleModel.encode` always writes both maps once `parse(url:)` ran.
  model.info = flat
  model.icon_info = icons
  return model
}

// `SkinEmoticonModel` + its two `SkinEmojiIconModel`s ([EMOJI]).
function emoticonModel(entries: Ini): Json {
  const icon: Json = { b: baseModel(entries), i_text: toInt(entries["TEXT_STYLE_INDEX"]) }
  return {
    b: baseModel(entries),
    i_text: toInt(entries["PANEL_BACK_STYLE_INDEX"]),
    index_t: toInt(entries["TAB_BACK_STYLE_INDEX"]),
    t_icon: icon,
    p_icon: icon,
    file: entries["LAYOUT_NAME"],
    b_line: toInt(entries["BOTTOM_LINE"]),
  }
}

// `SkinAdditionModel` ([MORE]).
function additionModel(entries: Ini): Json {
  const grid = toPoint(entries["GRID"])
  const layoutName = entries["LAYOUT_NAME"]
  const mapped = layoutName === undefined ? undefined : boardTypeFromIniCode(layoutName)
  const row = grid === undefined ? undefined : Math.trunc(grid[0])
  const col = grid === undefined ? undefined : Math.trunc(grid[1])
  return {
    b: baseModel(entries),
    row,
    col,
    i_h: toInt(entries["H_LINE_STYLE_INDEX"]),
    i_v: toInt(entries["V_LINE_STYLE_INDEX"]),
    i_c: toInt(entries["CELL_STYLE_INDEX"]),
    i_l: toInt(entries["LOCK_STYLE_INDEX"]),
    i_b: toInt(entries["BORDER_STYLE_INDEX"]),
    file_info: {},
    file: mapped ?? layoutName,
    l_color: entries["LINE_COLOR"],
  }
}

// `SkinTableModel` ([LIST] / [SEGMENT]).
function tableModel(entries: Ini): Json {
  return {
    b: baseModel(entries),
    order: toBool(entries["LIST_ORDER"]),
    side: toBool(entries["SCROLL_SIDE"]),
    t: toInt(entries["TYPE"]),
    count: toInt(entries["LIST_NUM"]),
    i_cell: toInt(entries["CELL_STYLE"]),
    i_last: undefined,
    i_scroll: toInt(entries["SCROLL_STYLE"]),
    pos: pointJson(toPoint(entries["POS"])),
    size: pointJson(toPoint(entries["SIZE"] ?? entries["CELL_SIZE"])),
    rect: rectJson(toRect(entries["VIEW_RECT"])),
    insets: insetsJson(toInsets(entries["PADDING"])),
    titles: entries["NAMES"] === undefined ? undefined : toCharacters(stripSpaces(entries["NAMES"])),
    values: entries["VALUES"] === undefined ? undefined : toCharacters(stripSpaces(entries["VALUES"])),
  }
}

// `SkinHelpCandModel` ([SCAND]).
function helpCandModel(entries: Ini): Json {
  return {
    b: baseModel(entries),
    i_i: toInt(entries["INPUT_STYLE"]),
    s_i: toInt(entries["SCAND_STYLE"]),
    insets: insetsJson(toInsets(entries["PADDING"])),
    rect: rectJson(toRect(entries["VIEW_RECT"])),
  }
}

// `SkinBoardDrawModel` ([PANEL]).
function boardDrawModel(entries: Ini): Json {
  const base = baseModel(entries)
  const borderStyle = toInt(entries["BORDER_ANIM_STYLE"]) ?? toInt(entries["PANEL_ANIM_STYLE"])
  const ranges = entries["BORDER_RANGE"]
  const border = borderStyle !== undefined && ranges !== undefined
    ? { a: borderStyle, r: borderRangesJson(ranges) }
    : undefined
  const model: Record<string, Json> = {
    b: base,
    exact: toBool(entries["NO_BLUR"]),
    right: toBool(entries["NO_F3_FIX"]),
    c_rect: toBool(entries["CUSTOM_RECT"]),
    top_o: undefined,
    size: pointJson(toPoint(entries["SIZE"])),
    f_size: pointJson(toPoint(entries["FIX_SIZE"])),
    i_b: undefined,
    i_f: undefined,
    extend: toInt(entries["ANIM_EXTEND"]),
    level: toInt(entries["ANIM_LEVEL"]),
    a_insets: insetsJson(toInsets(entries["PANEL_ANIM_INSET"])),
    bd: border === undefined ? undefined : { b: border },
  }
  const baseRecord = base as Record<string, Json>
  if (baseRecord.base_ba === undefined || baseRecord.base_ba === null) {
    baseRecord.base_ba = toInt(entries["ANIM_STYLE"])
  }
  return model
}

function borderRangesJson(text: string): Json {
  const ranges = text.split(";").flatMap((item) => {
    const parts = item.split(",")
    if (parts.length !== 2) return []
    const x = toDouble(parts[0])
    const y = toDouble(parts[1])
    if (x === undefined || y === undefined) return []
    return [[Math.min(Math.max(x, 0), 1), Math.min(Math.max(y, -1), 2)]]
  })
  return ranges.length === 0 ? undefined : ranges
}

// `SkinButtonModel` ([KEY*]).
function buttonModel(entries: Ini, sectionName: string): Json {
  const viewRect = toRect(entries["VIEW_RECT"])
  const touchRect = toRect(entries["TOUCH_RECT"]) ?? viewRect
  return {
    b: baseModel(entries),
    hasU: undefined,
    f: undefined,
    h_style: undefined,
    rect: rectJson(viewRect),
    hit_rect: rectJson(touchRect),
    offset: undefined,
    fix_b: undefined,
    id: sectionName.replace(/KEY/g, ""),
    values: valuesJson(buttonValues(entries)),
    fix_a: toTipsMap(entries["STAT_STYLE"]),
  }
}

// `SkinButtonFixModel` ([TIP*]) — the key is resolved through the action code table.
function buttonFixModel(entries: Ini): Json {
  const key = entries["KEY"]
  return {
    b: baseModel(entries),
    k: key === undefined ? undefined : actionCode(key) ?? key,
    v: valuesJson(buttonValues(entries)),
  }
}

// `SkinPosFixModel` ([OFFSET*]) — integers only, without trimming.
function posFixModel(entries: Ini): Json {
  const text = entries["POS"]
  if (text === undefined) return {}
  const parts = text.split(",")
  if (parts.length !== 2) return {}
  const x = toInt(parts[0])
  const y = toInt(parts[1])
  return x === undefined || y === undefined ? {} : { p: [x, y] }
}

// `SkinMotiveModel` ([FORCE*]).
function motiveModel(entries: Ini): Json {
  return {
    start: toDouble(entries["BEGIN"]),
    finish: toDouble(entries["END"]),
    value: toDouble(entries["VALUE"]),
  }
}

// `SkinLogoInfoModel` ([LOGO]) — `layoutName` is not part of the encoded model.
function logoModel(context: ExportContext, entries: Ini, filePath: string): Json {
  const base = baseModel(entries)
  const layoutName = entries["LAYOUT_NAME"]
  if (layoutName === undefined) return { b: base }
  const directory = filePath.slice(0, Math.max(0, filePath.lastIndexOf("/")))
  const logoPath = palmJoinPath(directory, `${layoutName}.ini`)
  const sections = sectionsOf(context, logoPath)
  if (sections === undefined) {
    context.warnings.push(`找不到 logo 布局：${logoPath} (from ${filePath})`)
    return { b: base }
  }
  let iconIndex: number | undefined
  let panelBase = base
  for (const section of sections) {
    if (section.name !== "PANEL") continue
    panelBase = baseModel(section.entries)
    iconIndex = toInt(section.entries["ICON_INDEX"])
  }
  const model: Record<string, Json> = { b: panelBase }
  if (iconIndex === undefined) return model
  for (const section of sections) {
    if (section.name !== `ICON${iconIndex}`) continue
    model.b_b = toInt(section.entries["BACK_STYLE"])
    model.b_f = toInt(section.entries["FORE_STYLE"])
    model.b_t = toInt(section.entries["TEXT_STYLE"])
  }
  return model
}

/* -------------------------------------------------------------- skin layout */

function keyboardModel(context: ExportContext, path: string, type: string): Json {
  const sections = sectionsOf(context, path) ?? []
  const model: Record<string, Json> = {}
  const keys: Json[] = []
  const tips: Record<string, Json> = {}
  const offsets: Record<string, Json> = {}
  const forces: Json[] = []
  for (const section of sections) {
    const name = section.name
    if (name === "GLOBAL") model.comm = constModel(section.entries)
    else if (name === "INPUT") model.input = composeModel(section.entries)
    else if (name === "CAND") model.cand = candidateModel(section.entries)
    else if (name === "PANEL") model.board = boardDrawModel(section.entries)
    else if (name === "HINT") model.hint = bubbleModel(section.entries)
    else if (name === "LOGO") model.logo = logoModel(context, section.entries, path)
    else if (name === "EMOJI") model.emoji = emoticonModel(section.entries)
    else if (name === "MORE") model.more = additionModel(section.entries)
    else if (name === "LIST") model.list = tableModel(section.entries)
    else if (name === "SEGMENT") model.seg = tableModel(section.entries)
    else if (name === "SCAND") model.top_cand = helpCandModel(section.entries)
    else if (name.startsWith("KEY")) keys.push(buttonModel(section.entries, name))
    else if (name.startsWith("TIP")) {
      const index = indexKey(name, "TIP")
      if (index !== undefined) tips[String(index)] = buttonFixModel(section.entries)
    } else if (name.startsWith("OFFSET")) {
      const index = indexKey(name, "OFFSET")
      if (index !== undefined) offsets[String(index)] = posFixModel(section.entries)
    } else if (name.startsWith("FORCE")) {
      forces.push(motiveModel(section.entries))
    }
  }
  model.keys = keys
  model.key_fix = tips
  model.offset = offsets
  model.force = forces
  model.type = type
  return model
}

export function layoutJson(context: ExportContext, paths: string[] | undefined): Json {
  if (paths === undefined) return undefined
  const maps: Record<string, Json> = {}
  const cands: Record<string, Json> = {}
  const hints: Record<string, Json> = {}
  for (const path of paths) {
    if (path.endsWith(".ini")) {
      const name = palmBaseName(path)
      const type = boardTypeFromIniFileName(name) ?? name.replace(/\.ini/g, "")
      maps[type] = keyboardModel(context, path, type)
    } else if (path.endsWith(".cnd")) {
      cands[stripExtension(path)] = candidateModelFromFile(context, path)
    } else if (path.endsWith(".pop")) {
      hints[stripExtension(path)] = bubbleModelFromFile(context, path)
    }
  }
  fixTouchRects(maps)
  return { b: maps, c: cands, h: hints }
}
