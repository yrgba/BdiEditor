import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { bdaAppearancePath, bdaStyleID } from '../src/bda.ts'
import { decodeBdaAppearance } from '../src/bda-decode.ts'
import { updateBdaImageInnerRect, updateBdaKeySound, updateBdaStyle } from '../src/bda-encode.ts'
import { bdaColorHex, pngSize } from '../src/bda-resolver.ts'
import { IniDocument } from '../src/ini.ts'
import { SkinArchive } from '../src/skin.ts'
import { bdaSkinArchive, buildSxiZip } from '../src/palm/palm-export.ts'
import { stripSpaces } from '../src/palm/palm-ini.ts'

const templateBytes = () => new Uint8Array(readFileSync(new URL('../public/default-template.bda', import.meta.url)))
const baseBytes = () => new Uint8Array(readFileSync(new URL('../public/bda-base.bds', import.meta.url)))
const sxiOf = (conversion) => unzipSync(buildSxiZip(conversion.archive).bytes)

// The built-in BDA template is a single-theme package: `port/`, `land/` and `res/` live at the
// archive root. The conversion keeps that one INI tree instead of growing an empty `dark/`
// sibling, which the Palm apps read as a real night skin with no layout in it.
test('a single-theme BDA converts to one INI tree at the archive root', () => {
  const converted = bdaSkinArchive(SkinArchive.open(templateBytes(), 'bda'), SkinArchive.open(baseBytes()))
  assert.equal(converted.archive.format, 'bds')
  const names = converted.archive.names()
  assert.ok(names.includes('Info.txt'))
  assert.ok(names.includes('light/skin/port/py_9.ini'))
  assert.equal(converted.archive.sourcePath('light/skin/port/py_9.ini'), 'port/py_9.ini')
  assert.ok(names.every((name) => !name.startsWith('dark/')))
})

test('BDA export to a palm skin has no night theme and keeps root level resources', () => {
  const converted = bdaSkinArchive(SkinArchive.open(templateBytes(), 'bda'), SkinArchive.open(baseBytes()))
  const files = sxiOf(converted)
  const skin = JSON.parse(new TextDecoder().decode(files['skin.json']))
  assert.deepEqual(Object.keys(skin).sort(), ['default', 'info', 'root'])
  assert.equal(skin.night, undefined)
  assert.equal(skin.default.i, 'file:///Info.txt')
  assert.ok(skin.default.r_info.length > 0)
  assert.ok(skin.default.r_info.every((path) => path.startsWith('res/')))
  // Only the INI/CSS sources are folded into skin.json; every image resource stays in the zip.
  assert.deepEqual(skin.default.r_info.filter((path) => files[path] === undefined), [])
  assert.ok(Object.keys(skin.default.s_info.info).length > 0)
  assert.ok(Object.keys(files).every((name) => !name.startsWith('dark/')))
})

// The two appearances of a BDA hold separate style tables: the same index means different
// things on port and land, so the stylesheets stay apart instead of the land pass writing
// over the port one (which left every port lookup dangling and drew an empty keyboard).
test('each orientation keeps its own stylesheet and resolves its layout', () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  const original = source.sourceFiles()
  const converted = bdaSkinArchive(source, SkinArchive.open(baseBytes()))
  const skin = JSON.parse(new TextDecoder().decode(sxiOf(converted)['skin.json'])).default
  for (const orientation of ['port', 'land']) {
    const appearance = decodeBdaAppearance(source.getBytes(bdaAppearancePath(source, 'light', orientation)))
    const styles = skin[`s_${orientation}`].ss_1
    const expected = ['image', 'color', 'text'].flatMap((type) =>
      [...appearance[`${type}Styles`].keys()].map((key) => bdaStyleID({ type, key })),
    )
    assert.deepEqual(Object.keys(styles).sort(), expected.sort(), `${orientation} style IDs`)
    assert.ok(Object.keys(skin[`${orientation}_layout`].b).length > 0)
    for (const [key, text] of appearance.textStyles) {
      const actual = styles[bdaStyleID({ type: 'text', key })].s_1
      const label = text.contentText === undefined ? undefined : stripSpaces(text.contentText.trimEnd())
      assert.equal(actual.text, label, `${orientation} text ${key}`)
      assert.equal(actual.c_normal, bdaColorHex(text.normalColor ?? 0))
      assert.equal(actual.c_hl, bdaColorHex(text.highlightColor ?? text.normalColor ?? 0))
      assert.equal(actual.f_s, text.fontSize || undefined)
      assert.equal(actual.f_n, text.fontName ? stripSpaces(text.fontName.trimEnd()) : undefined)
    }
  }
  assert.deepEqual(source.sourceFiles(), original)
  assert.equal(Object.keys(skin.s_info.ss_1).length, 0)
  // Key labels ride on the stylesheet: the BDA `contentText` has to land in `SHOW`.
  const labels = Object.values(skin.s_port.ss_1).map((style) => style.s_1?.text).filter(Boolean)
  assert.ok(labels.includes('1'), labels.slice(0, 20).join())
  assert.equal(skin.s_port.info['10001'][0].rect2, undefined)
})

test('a dark-only BDA theme becomes the root default skin', () => {
  const files = Object.fromEntries(Object.entries(unzipSync(templateBytes())).map(([path, bytes]) =>
    [path === 'Info.txt' ? path : `dark/${path}`, bytes],
  ))
  const converted = bdaSkinArchive(SkinArchive.open(zipSync(files), 'bda'), SkinArchive.open(baseBytes()))
  const exported = sxiOf(converted)
  const skin = JSON.parse(new TextDecoder().decode(exported['skin.json']))
  assert.equal(skin.night, undefined)
  assert.ok(Object.keys(skin.default.port_layout.b).length > 0)
  assert.ok(Object.keys(skin.default.land_layout.b).length > 0)
  assert.ok(Object.keys(exported).every((path) => !/^(?:dark|light)\//.test(path)))
})

test('a portrait-only BDA does not gain a landscape layout or night skin', () => {
  const files = Object.fromEntries(Object.entries(unzipSync(templateBytes())).filter(([path]) => !path.startsWith('land/')))
  const converted = bdaSkinArchive(SkinArchive.open(zipSync(files), 'bda'), SkinArchive.open(baseBytes()))
  const skin = JSON.parse(new TextDecoder().decode(sxiOf(converted)['skin.json']))
  assert.equal(skin.night, undefined)
  assert.equal(skin.default.land_layout, undefined)
  assert.equal(skin.default.s_land, undefined)
  assert.ok(Object.keys(skin.default.port_layout.b).length > 0)
  assert.ok(Object.keys(skin.default.s_port.ss_1).length > 0)
})

function setImage(source, orientation, id, normalRect = [0, 0, 0, 0], highlightRect = normalRect) {
  const path = bdaAppearancePath(source, 'light', orientation)
  let bytes = source.getBytes(path)
  const ref = { type: 'image', key: decodeBdaAppearance(bytes).imageStyles.keys().next().value }
  for (const property of ['NM_IMG', 'HL_IMG']) bytes = updateBdaStyle(bytes, ref, property, id)
  bytes = updateBdaImageInnerRect(bytes, ref, false, normalRect)
  bytes = updateBdaImageInnerRect(bytes, ref, true, highlightRect)
  source.setBytes(path, bytes)
  return bdaStyleID(ref)
}

test('orientation images with the same name retain their own bytes and tile sizes', () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  const common = source.getBytes('light/skin/res/10001.png')
  const local = source.names().filter((path) => path.endsWith('.png')).map((path) => source.getBytes(path))
    .find((bytes) => pngSize(bytes)?.width !== pngSize(common).width)
  assert.ok(local)
  const portStyle = setImage(source, 'port', 'orientation-image')
  const landStyle = setImage(source, 'land', 'orientation-image')
  source.setBytes('light/skin/res/orientation-image.png', common)
  source.setBytes('light/skin/port/res/orientation-image.png', local)
  const exported = sxiOf(bdaSkinArchive(source, SkinArchive.open(baseBytes())))
  const skin = JSON.parse(new TextDecoder().decode(exported['skin.json'])).default
  assert.deepEqual(exported['port/res/orientation-image.png'], local)
  assert.deepEqual(exported['land/res/orientation-image.png'], common)
  assert.equal(exported['res/orientation-image.png'], undefined)
  for (const [orientation, bytes, style] of [['port', local, portStyle], ['land', common, landStyle]]) {
    const styles = skin[`s_${orientation}`]
    assert.equal(styles.ss_1[style].s_2.normal, 'orientation-image,1')
    const { width, height } = pngSize(bytes)
    assert.deepEqual(styles.info['orientation-image'][0].rect1, [[0, 0], [width, height]])
  }
})

test('shared images keep separate normal, highlighted and orientation stretch slices', () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  const portStyle = setImage(source, 'port', 'stretch-image', [2, 3, 10, 11], [4, 5, 12, 13])
  const landStyle = setImage(source, 'land', 'stretch-image', [0, 0, 0, 10], [0, 0, 10, 0])
  source.setBytes('light/skin/res/stretch-image.png', source.getBytes('light/skin/res/10001.png'))
  const converted = bdaSkinArchive(source, SkinArchive.open(baseBytes()))
  const tile = IniDocument.parse(converted.archive.getText('light/skin/res/stretch-image.til'))
  assert.equal(tile.get('GLOBAL', 'TILE_NUM'), '3')
  const skin = JSON.parse(new TextDecoder().decode(sxiOf(converted)['skin.json'])).default
  assert.deepEqual(skin.s_port.ss_1[portStyle].s_2, { normal: 'stretch-image,1', hl: 'stretch-image,2' })
  assert.deepEqual(skin.s_land.ss_1[landStyle].s_2, { normal: 'stretch-image,3', hl: 'stretch-image,3' })
  assert.deepEqual(skin.s_port.info['stretch-image'].map((slice) => slice.rect2), [
    [[2, 3], [10, 11]], [[4, 5], [12, 13]], undefined,
  ])
})

test('Palm appearance tables preserve converted sound IDs and missing-sound warnings', () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  let sound = updateBdaKeySound(new Uint8Array(), 'default', { type: 5, resourceID: 'tap.ogg' })
  sound = updateBdaKeySound(sound, 'KEY_DELETE', { type: 5, resourceID: 'missing.ogg' })
  source.setBytes('light/skin/port/soundConfig', sound)
  const audio = new Uint8Array(readFileSync(new URL('fixtures/click.ogg', import.meta.url)))
  source.setBytes('light/skin/res/tap.ogg', audio)
  const converted = bdaSkinArchive(source, SkinArchive.open(baseBytes()))
  assert.ok(converted.warnings.some((warning) => warning.includes('missing.ogg')))
  const exported = sxiOf(converted)
  const skin = JSON.parse(new TextDecoder().decode(exported['skin.json'])).default
  assert.deepEqual(exported['res/tap.ogg'], audio)
  for (const orientation of ['port', 'land']) {
    const panel = skin[`${orientation}_layout`].b.t9Pinyin.board
    assert.equal(skin[`s_${orientation}`].ss_1[panel.b.base_s].s_4.path_1, 'tap.ogg')
  }
})

test('a BDA package with both themes still exports a night skin', () => {
  const files = {}
  for (const [path, bytes] of Object.entries(unzipSync(templateBytes()))) {
    if (path === 'Info.txt') continue
    files[`light/${path}`] = bytes
    files[`dark/${path}`] = bytes
  }
  files['Info.txt'] = strToU8('Name=dual\nSupportDarkMode=1\n')
  const converted = bdaSkinArchive(SkinArchive.open(zipSync(files), 'bda'), SkinArchive.open(baseBytes()))
  const skin = JSON.parse(new TextDecoder().decode(sxiOf(converted)['skin.json']))
  for (const theme of ['default', 'night']) {
    assert.ok(Object.keys(skin[theme].port_layout.b).length > 0, `${theme} port`)
    assert.ok(Object.keys(skin[theme].land_layout.b).length > 0, `${theme} land`)
    assert.ok(Object.keys(skin[theme].s_info.info).length > 0, `${theme} tiles`)
  }
})
