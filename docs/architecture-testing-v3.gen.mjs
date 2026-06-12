// Generates architecture-testing-v3.excalidraw — SNRC v3 wrapper-free system diagram.
//
//   node docs/architecture-testing-v3.gen.mjs
//
// Layout: edit POS (box top-left corners) to rearrange; text is positioned
// relative to its box, arrows auto-route edge-to-edge and are bound to the
// boxes (labels bound to arrows), so everything stays attached when dragged
// in Excalidraw. Current POS reflects the manual arrangement from

import { writeFileSync } from 'fs'

// ---------- layout ----------
const POS = {
  title:      [81, -134],
  user:       [28, -19],
  wallets:    [585, 1264],
  clients:    [1569, 440],
  multisig:   [1142, 896],
  controller: [-85, 292],
  registrar:  [488, 832],
  registry:   [531, 418],
  metadata:   [-105, 857],
  resolver:   [754, -66],
  oracle:     [-548, 552],
  chainlink:  [-549, 793],
  smpxnft:    [-517, 899],
  reverse:    [-581, 303],
  universal:  [1035, 420],
  note:       [-523, 1235],
  legend:     [1376, 1168],
}

// ---------- excalidraw plumbing ----------
let n = 0
const id = (p = 'el') => `${p}-${++n}`
const seed = () => Math.floor(Math.random() * 2 ** 31)
const base = (over) => ({
  id: id(), angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100,
  groupIds: [], frameId: null, seed: seed(), version: 1, versionNonce: seed(),
  isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...over,
})
const els = []
const boxes = {}   // key -> rect element

const box = (key, w, h, bg, extra = {}) => {
  const [x, y] = POS[key]
  const gid = `grp-${key}`
  const r = base({ id: `box-${key}`, type: 'rectangle', x, y, width: w, height: h,
    backgroundColor: bg, roundness: { type: 3 }, groupIds: [gid], boundElements: [], ...extra })
  els.push(r); boxes[key] = r
  return key
}
// text at (dx,dy) relative to box `key` (or absolute if key is null)
const text = (key, dx, dy, str, size = 12, extra = {}) => {
  const [bx, by] = key ? [boxes[key].x, boxes[key].y] : [0, 0]
  const lines = str.split('\n')
  const w = Math.max(...lines.map((l) => l.length)) * size * 0.58
  const h = lines.length * size * 1.25
  els.push(base({ type: 'text', x: bx + dx, y: by + dy, width: w, height: h, text: str,
    fontSize: size, fontFamily: 2, textAlign: 'left', verticalAlign: 'top',
    containerId: null, originalText: str, autoResize: true, lineHeight: 1.25,
    groupIds: key ? [`grp-${key}`] : [], ...extra }))
}
// point on rect edge along the line from its centre toward (tx,ty)
const edge = (r, tx, ty) => {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const dx = tx - cx, dy = ty - cy
  const t = Math.min(
    dx !== 0 ? Math.abs(r.width / 2 / dx) : Infinity,
    dy !== 0 ? Math.abs(r.height / 2 / dy) : Infinity,
  )
  return [cx + dx * t, cy + dy * t]
}
const arrow = (fromKey, toKey, label, dashed = false) => {
  const A = boxes[fromKey], B = boxes[toKey]
  const [x1, y1] = edge(A, B.x + B.width / 2, B.y + B.height / 2)
  const [x2, y2] = edge(B, A.x + A.width / 2, A.y + A.height / 2)
  const a = base({ id: id('arrow'), type: 'arrow', x: x1, y: y1,
    width: x2 - x1, height: y2 - y1,
    strokeStyle: dashed ? 'dashed' : 'solid', roundness: { type: 2 },
    points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null,
    startBinding: { elementId: A.id, focus: 0, gap: 4 },
    endBinding: { elementId: B.id, focus: 0, gap: 4 },
    startArrowhead: null, endArrowhead: 'arrow', elbowed: false, boundElements: [] })
  els.push(a)
  A.boundElements.push({ id: a.id, type: 'arrow' })
  B.boundElements.push({ id: a.id, type: 'arrow' })
  if (label) {
    const lines = label.split('\n')
    const fs = 10
    const w = Math.max(...lines.map((l) => l.length)) * fs * 0.58
    const h = lines.length * fs * 1.25
    const t = base({ id: id('lbl'), type: 'text',
      x: (x1 + x2) / 2 - w / 2, y: (y1 + y2) / 2 - h / 2, width: w, height: h,
      text: label, fontSize: fs, fontFamily: 2, textAlign: 'center',
      verticalAlign: 'middle', containerId: a.id, originalText: label,
      autoResize: true, lineHeight: 1.25, strokeColor: '#666666' })
    els.push(t)
    a.boundElements.push({ id: t.id, type: 'text' })
  }
}

// ---------- title ----------
text(null, POS.title[0], POS.title[1],
  'SNRC .testing v3 — wrapper-free architecture (on-chain label index #20 + fully on-chain NFT metadata)', 20)

// ---------- actors ----------
box('user', 300, 110, '#d0bfff')
text('user', 12, 10, 'User  (dApp)', 15)
text('user', 12, 34, 'registers names, edits records,\ncreates subnames; "My Names" via\ngetLabels + ownerOf multicall', 11)
box('wallets', 330, 110, '#d0bfff')
text('wallets', 12, 10, 'Wallets & marketplaces', 15)
text('wallets', 12, 34, 'MetaMask, OpenSea, …\nshow & trade names as plain ERC-721\n(image via tokenURI data: URI)', 11)
box('clients', 310, 110, '#d0bfff')
text('clients', 12, 10, 'SimpleX clients / resolver', 15)
text('clients', 12, 34, 'resolve alice.testing ->\nsimplex.contact / simplex.channel\ntext records', 11)
box('multisig', 320, 130, '#d0bfff')
text('multisig', 12, 10, 'SNCC multisig (admin)', 15)
text('multisig', 12, 34, 'owns: registry root, registrar,\ncontroller (UUPS upgrades),\nreverse registrars; can swap the\ntokenURI renderer (auditable tx)', 11)

// ---------- contracts ----------
box('controller', 450, 430, '#ffec99', { strokeWidth: 2 })
text('controller', 12, 10, 'SimplexController  (UUPS proxy)', 16)
text('controller', 12, 38, 'ROLE: registration gateway, TLD policy,\n           on-chain index (#20)', 12)
text('controller', 12, 80, 'STORES:\n- commitments (commit-reveal)\n- tldNode / tldSuffix / minCharLength\n- reservedNames, NFT-gate config\n- price-oracle ref (+ freeze flag)\n- labelOf[labelhash] -> label   (#20)\n- allLabels[]  (every 2LD ever)   (#20)\n- childrenOf[parentNode] -> labelhashes (#20)', 11)
text('controller', 12, 220, 'EXPOSES:\n- commit / register / renew  (payable)\n- rentPrice / available / valid\n- registerReserved / addReservedNames\n- submitLabel / submitSubname\n  (permissionless, hash-verified backfill)\n- getLabels / getChildren  (paginated views)\n- admin: setPriceOracle/freeze,\n  setMinCharLength, disableNftGate', 11)

box('registrar', 410, 310, '#b2f2bb', { strokeWidth: 2 })
text('registrar', 12, 10, 'BaseRegistrarImplementation  (v3)', 16)
text('registrar', 12, 38, 'ROLE: ERC-721 ledger of 2LDs + expiries\n           the name IS the NFT (no wrapper)', 12)
text('registrar', 12, 80, 'STORES:\n- owners / balances (tokenId = labelhash)\n- expiries[tokenId], grace period\n- controllers (= SimplexController)\n- baseNode = namehash("testing")', 11)
text('registrar', 12, 172, 'EXPOSES:\n- register / renew (onlyController)\n- ownerOf / transferFrom  (trading)\n- nameExpires / available / reclaim\n- v3 diff: ERC721(name, symbol) +\n  tokenURI() -> swappable renderer', 11)

box('registry', 350, 270, '#a5d8ff')
text('registry', 12, 10, 'ENSRegistry', 16)
text('registry', 12, 38, 'ROLE: the name tree — source of truth\n           for every node (incl. subnames)', 12)
text('registry', 12, 80, 'STORES:\n- node -> { owner, resolver, ttl }', 11)
text('registry', 12, 130, 'EXPOSES:\n- owner / resolver / ttl / recordExists\n- setSubnodeOwner  (subname creation,\n  parent-revocable by design)\n- setResolver / setRecord / setOwner', 11)

box('metadata', 410, 250, '#b2f2bb', { strokeWidth: 2 })
text('metadata', 12, 10, 'OnchainMetadataService  (new)', 16)
text('metadata', 12, 38, 'ROLE: fully on-chain NFT metadata —\n           no server, no IPFS', 12)
text('metadata', 12, 80, 'STORES:\n- static SVG artwork (bytecode constant,\n  same image for every name)', 11)
text('metadata', 12, 140, 'EXPOSES:\n- tokenURI(labelhash) ->\n  data:application/json;base64,{\n   name: "<label>.testing" (JSON-escaped),\n   description, image: data:image/svg+xml }', 11)

box('resolver', 350, 270, '#a5d8ff')
text('resolver', 12, 10, 'PublicResolver', 16)
text('resolver', 12, 38, 'ROLE: per-name records', 12)
text('resolver', 12, 64, 'STORES (per node):\n- addr(coinType)\n- text: simplex.contact, simplex.channel, ...\n- contenthash / pubkey / ABI', 11)
text('resolver', 12, 146, 'EXPOSES:\n- setText / setAddr / ... ; text / addr\n- multicallWithNodeCheck\n- auth: node owner | operator |\n  trustedETHController | trustedReverse', 11)

box('oracle', 250, 170, '#a5d8ff')
text('oracle', 12, 10, 'ExponentialPremium\nPriceOracle', 14)
text('oracle', 12, 54, 'ROLE: USD pricing + decaying\nre-registration premium\nSTORES: per-length prices\n(all 0 on .testing)\nEXPOSES: price(label,\nexpires, duration)', 11)
box('chainlink', 250, 70, '#e9ecef')
text('chainlink', 12, 10, 'Chainlink ETH/USD feed\n(external) latestRoundData', 12)

box('smpxnft', 220, 130, '#e9ecef')
text('smpxnft', 12, 10, 'SMPXNFT (external)', 14)
text('smpxnft', 12, 36, 'ROLE: .testing registration\ngate (ERC-721 holders only)\nEXPOSES: balanceOf(user)', 11)

box('reverse', 290, 210, '#a5d8ff')
text('reverse', 12, 10, 'ReverseRegistrar +\nDefaultReverseRegistrar', 14)
text('reverse', 12, 54, 'ROLE: primary names\n(address -> name)\nSTORES: addr.reverse subtree,\ndefault resolver\nEXPOSES: setNameForAddr\n(controller), claim / setName', 11)

box('universal', 290, 160, '#a5d8ff')
text('universal', 12, 10, 'UniversalResolver', 16)
text('universal', 12, 38, 'ROLE: one-call resolution\nfor clients\nEXPOSES: resolve(name, query)\n-> reads registry + resolver', 11)

// ---------- dropped-wrapper note ----------
box('note', 660, 120, '#ffc9c9')
text('note', 12, 10, 'DROPPED: NameWrapper (ERC-1155, fuses, emancipation)', 13)
text('note', 12, 36, '2LDs trade as plain ERC-721. Subnames are registry entries (parent-revocable —\nthe right semantic for org delegation; revisit wrapper only if trustless subname\nsales become a requirement). Subgraph: optional (history only), per #20.', 11)

// ---------- legend ----------
box('legend', 290, 170, '#ffffff')
text('legend', 12, 10, 'LEGEND', 13)
const sw = (dy, c) => els.push(base({ type: 'rectangle',
  x: boxes.legend.x + 12, y: boxes.legend.y + dy, width: 18, height: 12,
  backgroundColor: c, roundness: { type: 3 }, groupIds: ['grp-legend'] }))
sw(36, '#ffec99'); text('legend', 38, 34, 'SNRC custom (UUPS)', 11)
sw(58, '#b2f2bb'); text('legend', 38, 56, 'new / small diff in v3', 11)
sw(80, '#a5d8ff'); text('legend', 38, 78, 'verbatim upstream ENS', 11)
sw(102, '#e9ecef'); text('legend', 38, 100, 'external', 11)
sw(124, '#d0bfff'); text('legend', 38, 122, 'actors', 11)

// ---------- arrows ----------
arrow('user', 'controller', 'commit / register / renew;\nsubmitLabel / submitSubname; getLabels')
arrow('user', 'registry', 'setSubnodeOwner (create subname)')
arrow('user', 'resolver', 'setText("simplex.contact", ...)')
arrow('wallets', 'registrar', 'ownerOf / tokenURI / transferFrom')
arrow('clients', 'universal', 'resolve(alice.testing)')
arrow('multisig', 'registrar', 'swap tokenURI renderer', true)
arrow('controller', 'registrar', 'register / renew\n(onlyController)')
arrow('controller', 'registry', 'setRecord(node, owner, resolver)')
arrow('controller', 'resolver', 'multicallWithNodeCheck\n(records at registration)')
arrow('controller', 'reverse', 'setNameForAddr (reverse record)')
arrow('controller', 'smpxnft', 'balanceOf (gate)')
arrow('controller', 'oracle', 'price()')
arrow('oracle', 'chainlink', 'ETH/USD')
arrow('registrar', 'registry', 'setSubnodeOwner(TLD, labelhash)\non register / reclaim')
arrow('registrar', 'metadata', 'tokenURI() delegates (view)')
arrow('metadata', 'controller', 'labelOf(labelhash) (view)')
arrow('universal', 'registry', 'owner / resolver')
arrow('universal', 'resolver', 'text / addr')

const doc = {
  type: 'excalidraw', version: 2, source: 'snrc-architecture-generator',
  elements: els, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {},
}
writeFileSync(new URL('./architecture-testing-v3.excalidraw', import.meta.url).pathname,
  JSON.stringify(doc, null, 1))
console.log('elements:', els.length)
