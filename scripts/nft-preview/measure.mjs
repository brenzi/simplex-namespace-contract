import { createRequire } from 'module'
// puppeteer is an optional, dev-only dependency (see render.mjs).
const require = createRequire(import.meta.url)
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer')
const mk = (ch, n, w) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text id="t" x="0" y="50" font-family="sans-serif" font-size="100" font-weight="${w}">${ch.repeat(n)}</text></svg>`
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
for (const [ch, n] of [['m', 20], ['w', 20], ['W', 20], ['x', 20], ['abcdefghij0123456789', 1]]) {
  await page.setContent(mk(ch, n, 'bold'))
  const len = await page.evaluate(() => document.getElementById('t').getComputedTextLength())
  const chars = ch.length * n
  console.log(`${ch.length>1?'mixed':ch} bold: ${(len/(chars*100)).toFixed(3)} em/char`)
}
await browser.close()
