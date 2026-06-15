import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { tileInner, layout } from './gen.mjs'
const DIR = dirname(fileURLToPath(import.meta.url))

// entries: {label} -> name = label + '.testing'; or {name, cap} for an explicit full name
const cases = [
  { label: 'ffobar' },
  { label: 'satoshinakamoto' },
  { label: 'a-fairly-long-name22' },
  { label: 'm'.repeat(40) },
  { label: 'm'.repeat(63) },
  { label: 'w'.repeat(63) },
]

const GAP = 16, TILE = 500, CAP = 30, COLS = 2
const rows = Math.ceil(cases.length / COLS)
const W = COLS * TILE + (COLS + 1) * GAP
const H = rows * (TILE + CAP) + (rows + 1) * GAP

let body = `<rect width="${W}" height="${H}" fill="#222"/>`
cases.forEach((c, i) => {
  const name = c.name ?? (c.label + '.testing')
  const inner = c.name ? tileInner(c.name, 'g' + i, '') : tileInner(c.label, 'g' + i)
  const L = layout(name.length)
  const cap = c.cap
    ? `${cap0(name.length, L)}  |  ${c.cap}`
    : `${c.label.length}-char label -> name ${name.length}  |  ${L.size}px x ${L.lines} line(s)`
  const col = i % COLS, row = (i / COLS) | 0
  const x = GAP + col * (TILE + GAP)
  const y = GAP + row * (TILE + CAP + GAP)
  body += `<text x="${x}" y="${y + 20}" font-family="monospace" font-size="15" fill="#fff">${cap}</text>`
  body += `<svg x="${x}" y="${y + CAP}" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">${inner}</svg>`
})
function cap0(len, L) { return `name ${len}  |  ${L.size}px x ${L.lines} line(s)` }

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`
writeFileSync(join(DIR, 'sheet.svg'), svg)
console.log('sheet', W, 'x', H, '| rows', rows)
