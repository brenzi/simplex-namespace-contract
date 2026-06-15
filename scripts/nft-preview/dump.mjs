import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { tileSVG } from './gen.mjs'
const DIR = dirname(fileURLToPath(import.meta.url))

const cases = [
  ['ffobar', 'ffobar'],
  ['satoshinakamoto', 'satoshinakamoto'],
  ['a-fairly-long-name22', 'a-fairly-long-name22'],
  ['m40', 'm'.repeat(40)],
  ['m63', 'm'.repeat(63)],
  ['w63', 'w'.repeat(63)],
]
for (const [fname, label] of cases) {
  const f = join(DIR, `tile-${fname}.svg`)
  writeFileSync(f, tileSVG(label))
  console.log('wrote', `tile-${fname}.svg`)
}
