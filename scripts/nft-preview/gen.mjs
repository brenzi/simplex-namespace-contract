import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const DIR = dirname(fileURLToPath(import.meta.url))

// Official SimpleX brand mark, dark-theme variant (34x35 viewBox), two paths:
// P1 solid white, P2 filled with the brand cyan->blue gradient.
export const P1 = 'M3.02958 8.60922L8.622 14.2013L14.3705 8.45375L17.1669 11.2498L11.4183 16.9972L17.0114 22.5895L14.1373 25.4633L8.54422 19.871L2.79636 25.6187L0 22.8227L5.74794 17.075L0.155484 11.483L3.02958 8.60922Z'
export const P2 = 'M14.0923 25.5156L16.944 22.6642L16.9429 22.6634L22.6467 16.9612L17.0513 11.3675L17.0523 11.367L14.2548 8.56979L8.65972 2.97535L11.5114 0.123963L17.1061 5.71849L22.8099 0.015625L25.6074 2.81285L19.9035 8.51562L25.4984 14.1099L31.2025 8.40729L34 11.2045L28.2958 16.907L33.8917 22.5017L31.0399 25.3531L25.4442 19.7584L19.7409 25.4611L25.3365 31.0559L22.4848 33.9073L16.8892 28.3124L11.1864 34.0156L8.38885 31.2184L14.0923 25.5156Z'

// --- layout heuristic (char-count based, portable to Solidity) ---
// Worst-case safe: K is the assumed max glyph advance per em (lowercase 'm' in
// bold sans ~0.83). USABLE is the text width budget (canvas 500 - 2*24 margin).
// Pick the FEWEST lines (1..3) whose computed font size clears a per-line-count
// floor; size = USABLE / (charsPerLine * K), capped per line count.
// K = worst-case lowercase glyph advance (measured: bold 'm' = 1.042 em),
// with a small cross-font buffer. Sizing to this guarantees even an all-'m'
// label keeps the 5% side margins (USABLE = 500 - 2*25).
export const K = 1.05
const USABLE = 450
const MIN = 14
const MAXLINES = 3 // max rendered name = 63-char 2LD + ".testing" = 71 chars (subnames aren't tokens)
const MAXForLines = { 1: 44, 2: 30, 3: 24 }
const FLOORForLines = { 1: 22, 2: 16, 3: MIN }

export function layout(len) {
  for (let lines = 1; lines <= MAXLINES; lines++) {
    const perLine = Math.ceil(len / lines)
    let size = Math.floor(USABLE / (perLine * K))
    if (size > MAXForLines[lines]) size = MAXForLines[lines]
    if (size >= FLOORForLines[lines] || lines === MAXLINES)
      return { size: Math.max(size, MIN), lines }
  }
}

// balanced split into `lines` chunks (ASCII-simple; UTF-8 split-safety is a
// Solidity-port concern noted separately)
function wrap(s, lines) {
  if (lines === 1) return [s]
  const per = Math.ceil(s.length / lines)
  const out = []
  for (let i = 0; i < s.length; i += per) out.push(s.slice(i, i + per))
  return out
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Inner content of a 500x500 tile (no outer <svg>); gradId makes the gradient
// id unique when many tiles share one document.
export function tileInner(label, gradId = 'g', suffix = '.testing') {
  const name = label + suffix
  const { size, lines } = layout(name.length)
  const parts = wrap(name, lines).map(xmlEscape)
  const lineH = Math.round(size * 1.2)
  const blockH = lines * lineH
  const firstBaseline = Math.round(252 - blockH / 2 + size * 0.74)
  const tspans = parts.map((p, i) =>
    `<tspan x="250" y="${firstBaseline + i * lineH}">${p}</tspan>`).join('')
  const lg = 'l' + gradId
  const tg = 't' + gradId
  return `<defs>` +
    // background: CSS linear-gradient(30deg) black (bottom-left) -> warm white
    // (top-right); userSpaceOnUse endpoints = the 30deg magic-corner line on a
    // 500x500 box (L = 500*sin30 + 500*cos30 = 683.01, centred).
    `<linearGradient id="${gradId}" x1="79.25" y1="545.75" x2="420.75" y2="-45.75" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0%" stop-color="#000000"/><stop offset="52%" stop-color="#131D49"/><stop offset="65%" stop-color="#3F5598"/><stop offset="85%" stop-color="#C3FAFF"/><stop offset="90%" stop-color="#FFF6E0"/></linearGradient>` +
    // brand logo gradient (P2): cyan -> blue, official userSpaceOnUse coords (applied inside the logo group)
    `<linearGradient id="${lg}" x1="12.8381" y1="-0.678252" x2="9.54355" y2="31.4493" gradientUnits="userSpaceOnUse">` +
    `<stop stop-color="#01F1FF"/><stop offset="1" stop-color="#0197FF"/></linearGradient>` +
    // name text gradient: linear-gradient(90deg, #019bfe 0%, #64fdff 100%)
    `<linearGradient id="${tg}" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="#019bfe"/><stop offset="100%" stop-color="#64fdff"/></linearGradient>` +
    `</defs>` +
    `<rect width="500" height="500" fill="url(#${gradId})"/>` +
    // SimpleX brand mark, top-left (~66px): P1 white, P2 brand gradient
    `<g transform="translate(36,36) scale(1.95)"><path fill-rule="evenodd" clip-rule="evenodd" d="${P1}" fill="#ffffff"/><path fill-rule="evenodd" clip-rule="evenodd" d="${P2}" fill="url(#${lg})"/></g>` +
    `<text font-family="sans-serif" font-size="${size}" font-weight="bold" fill="url(#${tg})" text-anchor="middle">${tspans}</text>`
}

export function tileSVG(label, suffix = '.testing') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">${tileInner(label, 'g', suffix)}</svg>`
}

// CLI: node gen.mjs '{"label":"ffobar"}'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const o = JSON.parse(process.argv[2] || '{}')
  const svg = tileSVG(o.label ?? 'ffobar', o.suffix ?? '.testing')
  writeFileSync(join(DIR, 'out.svg'), svg)
  console.log('len', (o.label ?? 'ffobar').length + (o.suffix ?? '.testing').length, layout(((o.label ?? 'ffobar') + (o.suffix ?? '.testing')).length))
}
