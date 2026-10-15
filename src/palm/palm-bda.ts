import { strToU8 } from "fflate"
import { convertBdaArchive } from "../bda-convert.ts"
import { bdaAppearancePath, bdaConfigPath, bdaStyleID, type BdaImageAtom } from "../bda.ts"
import { decodeBdaAnimation, decodeBdaAppearance } from "../bda-decode.ts"
import { bdaColorHex, pngSize } from "../bda-resolver.ts"
import { IniDocument } from "../ini.ts"
import { SkinArchive } from "../skin.ts"

const ORIENTATIONS = ["port", "land"] as const

// Keep the shared converter's layouts, sound IDs and downgrade warnings. Palm needs
// separate appearance tables because the same style ID differs between orientations.
export function bdaSkinArchive(source: SkinArchive, base: SkinArchive): { archive: SkinArchive; warnings: string[] } {
  const conversion = convertBdaArchive(source, base)
  const themes = (["light", "dark"] as const).filter((theme) =>
    ORIENTATIONS.some((orientation) => bdaAppearancePath(source, theme, orientation) !== undefined),
  )
  const output = new Map<string, Uint8Array>()
  for (const path of conversion.archive.names()) {
    const themed = path.match(/^(light|dark)\/skin\//)
    if (themed && !themes.some((theme) => theme === themed[1])) continue
    if (/\/res\/.*\.(?:css|til|png)$/i.test(path)) continue
    const bytes = conversion.archive.getBytes(path)
    if (bytes) output.set(path, bytes)
  }

  for (const theme of themes) {
    const sharedStyles = IniDocument.parse(conversion.archive.getText(`${theme}/skin/res/default.css`))
    const soundSections = sharedStyles.sections().filter((section) => sharedStyles.get(section, "PRESS_SOUND_PATH") !== undefined)
    const tiles = new Map<string, { document: IniDocument; slices: Map<string, number> }>()
    for (const orientation of ORIENTATIONS) {
      const appearancePath = bdaAppearancePath(source, theme, orientation)
      if (!appearancePath) continue
      const appearance = decodeBdaAppearance(source.getBytes(appearancePath)!)
      const animationPath = bdaConfigPath(source, theme, orientation, "animation")
      const sequences = animationPath ? decodeBdaAnimation(source.getBytes(animationPath)!).sequences : undefined
      const styles = IniDocument.parse("[GLOBAL]\n")
      const imageSpec = (atom: BdaImageAtom | undefined): string | undefined => {
        const original = atom?.resource?.resourceID
        if (!original) return
        const resourceID = sequences?.get(original)?.frames.find((frame) => frame.resourceID)?.resourceID ?? original
        const id = resourceID.replace(/\.png$/i, "")
        const path = [`${theme}/skin/${orientation}/res/${id}.png`, `${theme}/skin/res/${id}.png`]
          .find((candidate) => source.isImage(candidate))
        const bytes = path && source.getBytes(path)
        if (!bytes) return
        // A local image must never share a tile ID with a different common image.
        const scoped = ORIENTATIONS.some((value) => source.isImage(`${theme}/skin/${value}/res/${id}.png`))
        const directory = scoped ? `${theme}/skin/${orientation}/res` : `${theme}/skin/res`
        const target = `${directory}/${id}`
        const inner = atom?.innerRect
        const stretch = inner && inner.width > 0 && inner.height > 0 ? inner : undefined
        const signature = stretch ? `${stretch.x},${stretch.y},${stretch.width},${stretch.height}` : ""
        let tile = tiles.get(target)
        if (!tile) {
          tile = { document: IniDocument.parse("[GLOBAL]\n"), slices: new Map() }
          tiles.set(target, tile)
          output.set(`${target}.png`, bytes)
        }
        let index = tile.slices.get(signature)
        if (index === undefined) {
          const size = pngSize(bytes)
          if (!size) throw new Error("BDA 资源不是有效的 PNG")
          index = tile.slices.size + 1
          tile.slices.set(signature, index)
          tile.document.set("GLOBAL", "TILE_NUM", String(index))
          tile.document.appendSection(`IMG${index}`, [
            { key: "SOURCE_RECT", value: `0,0,${size.width},${size.height}` },
            ...(stretch ? [{ key: "INNER_RECT", value: signature }] : []),
          ])
          output.set(`${target}.til`, strToU8(tile.document.toString()))
        }
        return `${id},${index}`
      }
      for (const [key, style] of appearance.imageStyles) {
        const normal = imageSpec(style.normalImage)
        const highlighted = imageSpec(style.highlightImage) ?? normal
        styles.appendSection(`STYLE${bdaStyleID({ type: "image", key })}`, [
          ...(normal ? [{ key: "NM_IMG", value: normal }] : []),
          ...(highlighted ? [{ key: "HL_IMG", value: highlighted }] : []),
        ])
      }
      for (const [key, style] of appearance.colorStyles) {
        styles.appendSection(`STYLE${bdaStyleID({ type: "color", key })}`, [
          { key: "NM_COLOR", value: bdaColorHex(style.normalColor ?? 0) },
          { key: "HL_COLOR", value: bdaColorHex(style.highlightColor ?? style.normalColor ?? 0) },
        ])
      }
      for (const [key, style] of appearance.textStyles) {
        styles.appendSection(`STYLE${bdaStyleID({ type: "text", key })}`, [
          ...(style.contentText !== undefined ? [{ key: "SHOW", value: style.contentText }] : []),
          ...(style.fontName ? [{ key: "FONT_NAME", value: style.fontName }] : []),
          ...(style.fontSize ? [{ key: "FONT_SIZE", value: String(style.fontSize) }] : []),
          { key: "NM_COLOR", value: bdaColorHex(style.normalColor ?? 0) },
          { key: "HL_COLOR", value: bdaColorHex(style.highlightColor ?? style.normalColor ?? 0) },
        ])
      }
      for (const section of soundSections) styles.appendSection(section, sharedStyles.entries(section))
      styles.set("GLOBAL", "STYLE_NUM", String(styles.sections().length - 1))
      output.set(`${theme}/skin/${orientation}/res/default.css`, strToU8(styles.toString()))
    }
  }

  // Only real themes become Palm skin trees. A single theme is the default at the root.
  const files = [...output].map(([path, data]) => {
    const themed = path.match(/^(light|dark)\/skin\/(.*)$/)
    return { path: themed ? `${themes.length === 1 ? "" : `${themed[1]}/`}${themed[2]}` : path, data }
  })
  return { archive: SkinArchive.fromSourceFiles(files), warnings: conversion.warnings }
}
