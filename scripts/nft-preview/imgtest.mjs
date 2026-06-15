// Renders tiles the way MetaMask does: inside <img src="data:image/svg+xml;base64,...">
// (SVG "secure static mode" — stricter than opening the SVG as a document).
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
// puppeteer is an optional, dev-only dependency (see render.mjs).
const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer')
const DIR = dirname(fileURLToPath(import.meta.url))
const files = ['tile-ffobar.svg', 'tile-m63.svg']
const imgs = files.map(f => {
  const b64 = Buffer.from(readFileSync(join(DIR, f))).toString('base64')
  return `<figure style="margin:0"><img width="320" height="320" src="data:image/svg+xml;base64,${b64}"><figcaption style="color:#aaa;font:13px monospace">${f}  (via &lt;img&gt; data-uri)</figcaption></figure>`
}).join('')
const html = `<body style="margin:0;background:#444;display:flex;gap:20px;padding:20px">${imgs}</body>`
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 720, height: 380, deviceScaleFactor: 1 })
await page.setContent(html, { waitUntil: 'networkidle0' })
await page.screenshot({ path: join(DIR, 'imgtest.png') })
await browser.close()
console.log('wrote imgtest.png')
