import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { SkinArchive } from '../src/skin.ts'
import { convertBdaArchive } from '../src/bda-convert.ts'
import { bdaSkinArchive } from '../src/palm/palm-bda.ts'

const templateBytes = () => new Uint8Array(readFileSync(new URL('../public/default-template.bda', import.meta.url)))
const baseBytes = () => new Uint8Array(readFileSync(new URL('../public/bda-base.bds', import.meta.url)))
const strFromU8 = (bytes) => new TextDecoder().decode(bytes)

// Palm adaptation must not change the shared BDI/BDS conversion.
test('BDA → BDI/BDS keeps the package shapes it always shipped', async () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  const base = SkinArchive.open(baseBytes())
  const files = unzipSync(await convertBdaArchive(source, base, 'bds').archive.platformBytesAsync('bds'))
  const names = Object.keys(files)
  const prefix = names.some((name) => name.startsWith('light/')) ? 'light/' : ''
  assert.ok(names.includes(`${prefix}res/default.css`), names.join())
  assert.ok(!names.some((name) => /\/(?:port|land)\/res\/default\.css$/.test(name)))
  const tile = strFromU8(files[`${prefix}res/10001.til`])
  assert.match(tile, /^IMG_NUM=1$/m)
  assert.match(tile, /^INNER_RECT=0,0,0,0$/m)
  assert.doesNotMatch(strFromU8(files[`${prefix}res/default.css`]), /^SHOW=/m)
})

test('Palm adaptation separates stylesheets and omits empty stretch areas', async () => {
  const source = SkinArchive.open(templateBytes(), 'bda')
  const base = SkinArchive.open(baseBytes())
  const files = unzipSync(await bdaSkinArchive(source, base).archive.platformBytesAsync('bds'))
  const names = Object.keys(files)
  const prefix = names.some((name) => name.startsWith('light/')) ? 'light/' : ''
  for (const orientation of ['port', 'land']) {
    assert.ok(names.includes(`${prefix}${orientation}/res/default.css`), names.join())
  }
  assert.match(strFromU8(files[`${prefix}port/res/default.css`]), /^SHOW=/m)
  const tile = strFromU8(files[`${prefix}res/10001.til`])
  assert.match(tile, /^TILE_NUM=1$/m)
  assert.doesNotMatch(tile, /^INNER_RECT=/m)
})
