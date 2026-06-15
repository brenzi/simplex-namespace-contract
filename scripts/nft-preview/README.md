# NFT preview — reference renderer for `MetadataRenderer.sol`

This folder is the **off-chain reference** for the on-chain SimpleX name NFT
artwork. `gen.mjs` is the canonical design; the Solidity
`MetadataRenderer.sol` (`ens-contracts/contracts/simplex/`) is a hand-port of it
and produces **byte-for-byte identical** SVG. Iterate on the look here first
(fast, no compile), then mirror any change into the contract.

These are dev-only scripts. They are **not** wired into the build or deploy and
have no `package.json`; `gen.mjs`/`dump.mjs`/`sheet.mjs` are pure Node (no deps),
and the three browser scripts need `puppeteer` (see below).

## Files

- `gen.mjs` — **canonical renderer.** `tileSVG(label, suffix='.testing')` returns
  the full SVG; `tileInner(label, gradId, suffix)` returns the inner markup
  (for compositing); `layout(len)` returns `{size, lines}`. The contract mirrors
  this exactly, including the layout heuristic and element/attribute order.
- `dump.mjs` — writes the per-case `tile-*.svg` reference files (no deps).
- `sheet.mjs` — writes `sheet.svg`, a 2-column contact sheet of all cases (no deps).
- `render.mjs <svg> <png> <W> <H>` — rasterise one SVG to PNG (puppeteer).
- `imgtest.mjs` — renders tiles inside `<img src="data:image/svg+xml;base64,…">`,
  i.e. SVG "secure static mode", the closest local approximation of how MetaMask
  displays the artwork (puppeteer).
- `measure.mjs` — measures real bold glyph advance via `getComputedTextLength`
  (puppeteer). This is where the `K = 1.05` worst-case 'm' advance in the layout
  heuristic comes from.
- `tile-*.svg`, `sheet.svg` — committed reference outputs. `dump.mjs` regenerates
  the tiles byte-identically; they are kept so the design can be eyeballed (and
  diffed) without running anything.

The six reference cases are: `ffobar`, `satoshinakamoto`,
`a-fairly-long-name22`, `m`×40, `m`×63, `w`×63 (the last two are the
worst-case all-wide-glyph names at the 63-char label cap).

## Run

```sh
node dump.mjs        # regenerate tile-*.svg
node sheet.mjs       # regenerate sheet.svg

# browser scripts — install puppeteer here, or point at an existing install:
npm i puppeteer
#   …or: export PUPPETEER_PATH=/abs/path/to/node_modules/puppeteer
node render.mjs tile-m63.svg tile-m63.png 500 500
node imgtest.mjs     # writes imgtest.png (MetaMask-like <img> rendering)
node measure.mjs     # prints em/char advances
```

## Verifying the contract still matches

The contract and `gen.mjs` must stay in sync. To check, deploy
`MetadataRenderer('.testing')`, decode the base64 SVG out of `tokenURI`, and
compare it to `tileSVG(label, '.testing')` for the six cases above — they must be
identical. (A throwaway Hardhat/vitest test that imports `tileSVG` from here does
this in a couple of lines.) If you change the artwork, change both and re-verify.
