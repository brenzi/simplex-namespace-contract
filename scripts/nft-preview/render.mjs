// render.mjs <svg-path> <png-path> <width> <height>
import { createRequire } from 'module'
// puppeteer is an optional, dev-only dependency for these preview scripts; it is
// not a project dependency. Install it (`npm i puppeteer`) in this folder, or
// point PUPPETEER_PATH at an existing install.
const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer')
const [svgPath, pngPath, W, H] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5]]
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
await page.goto('file://' + svgPath, { waitUntil: 'networkidle0' })
await page.screenshot({ path: pngPath })
await browser.close()
console.log('rendered', pngPath, W, 'x', H)
