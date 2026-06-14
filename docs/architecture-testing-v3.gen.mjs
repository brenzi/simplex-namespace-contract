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
  title:      [58, -487],
  user:       [-104, -315],
  wallets:    [605, 1605],
  clients:    [1662, 549],
  multisig:   [1235, 944],
  controller: [-174, 315],
  registrar:  [504, 949],
  registry:   [578, 467],
  subnames:   [461, -27],
  metadata:   [-118, 1003],
  resolver:   [877, -395],
  oracle:     [-548, 552],
  chainlink:  [-549, 793],
  smpxnft:    [-495, 951],
  reverse:    [-581, 303],
  universal:  [1124, 524],
  note:       [-486, 1559],
  legend:     [1376, 1168],
  keys:       [1206, 1360],
}

// Hand-tuned arrow geometry (bend points + endpoints) captured from the manual
// arrangement, keyed by "from->to". Arrows not listed fall back to straight
// edge-to-edge routing. x,y is the arrow origin; points are relative to it.
const GEOM = {
  "user->controller": { x: 46.56, y: -199.42, points: [[0,0],[4.65,508.44]] },
  "user->registrar": { x: 74.98, y: -199.42, points: [[0,0],[371.55,789.4],[547.09,1142.14]] },
  "user->subnames": { x: 180.46, y: -200.75, points: [[0,0],[260.12,114.89],[314.03,167.42]] },
  "user->resolver": { x: 201.98, y: -259.88, points: [[0,0],[669.82,0.11]] },
  "wallets->registrar": { x: 769.25, y: 1599.78, points: [[0,0],[-1.8,-145.05]] },
  "clients->universal": { x: 1656.97, y: 605.05, points: [[0,0],[-237.65,-2.74]] },
  "multisig->registrar": { x: 1231.18, y: 1056.98, points: [[0,0],[-230.74,67.92]] },
  "controller->registrar": { x: 223.41, y: 661.02, points: [[0,0],[284.96,291.29]] },
  "controller->resolver": { x: 106.81, y: 309.02, points: [[0,0],[118.85,-376.66],[764.99,-526.83]] },
  "controller->reverse": { x: -179.78, y: 461.76, points: [[0,0],[-105.72,-38.18]] },
  "controller->smpxnft": { x: -93.42, y: 661.02, points: [[0,0],[-233.88,284.65]] },
  "controller->oracle": { x: -179.78, y: 559.07, points: [[0,0],[-112.72,36.11]] },
  "oracle->chainlink": { x: -423.45, y: 722, points: [[0,0],[-0.37,71]] },
  "subnames->registry": { x: 694.01, y: 358.68, points: [[0,0],[63.8,102.74]] },
  "registrar->registry": { x: 737.34, y: 942.72, points: [[0,0],[22.13,-200.3]] },
  "registrar->metadata": { x: 498.44, y: 1160.02, points: [[0,0],[-200.48,0]] },
  "universal->registry": { x: 1118.32, y: 603.11, points: [[0,0],[-184.63,-0.59]] },
  "universal->resolver": { x: 1221.45, y: 518.07, points: [[0,0],[-89.76,-637.37]] },
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
  // Prefer hand-tuned geometry (bends + endpoints) captured from the manual
  // arrangement; fall back to straight edge-to-edge for any arrow not in GEOM.
  const g = GEOM[`${fromKey}->${toKey}`]
  let x1, y1, pts
  if (g) {
    x1 = g.x; y1 = g.y; pts = g.points
  } else {
    const [ax, ay] = edge(A, B.x + B.width / 2, B.y + B.height / 2)
    const [bx, by] = edge(B, A.x + A.width / 2, A.y + A.height / 2)
    x1 = ax; y1 = ay; pts = [[0, 0], [bx - ax, by - ay]]
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const a = base({ id: id('arrow'), type: 'arrow', x: x1, y: y1,
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    strokeStyle: dashed ? 'dashed' : 'solid', roundness: { type: 2 },
    points: pts, lastCommittedPoint: null,
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
    // bound label: Excalidraw positions it along the arrow path; midpoint is a fine seed
    const mx = x1 + (pts[0][0] + pts[pts.length - 1][0]) / 2
    const my = y1 + (pts[0][1] + pts[pts.length - 1][1]) / 2
    const t = base({ id: id('lbl'), type: 'text',
      x: mx - w / 2, y: my - h / 2, width: w, height: h,
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
text('user', 12, 34, 'registers names, edits records,\ncreates subnames (via controller);\n"My Names" via getLabels + ownerOf', 11)
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
box('controller', 450, 340, '#ffec99', { strokeWidth: 2 })
text('controller', 12, 10, 'SimplexController  (UUPS proxy)', 16)
text('controller', 12, 38, 'ROLE: 2LD registration gateway + TLD policy\n           (no name index — see registrar / subnames)', 12)
text('controller', 12, 80, 'STORES (key -> value):\n- commitments[bytes32 commitment] -> uint ts\n- reservedNames[bytes32 labelhash] -> bool\n- tldNode / tldSuffix / minCharLength\n- NFT-gate config; priceOracle ref (+ freeze)', 11)
text('controller', 12, 184, 'EXPOSES:\n- commit / register / renew  (payable)\n  (passes the plaintext label to registrar)\n- rentPrice / available / valid\n- registerReserved / addReservedNames\n- admin: setPriceOracle/freeze,\n  setMinCharLength, disableNftGate', 11)

box('registrar', 490, 500, '#b2f2bb', { strokeWidth: 2 })
text('registrar', 12, 10, 'BaseRegistrarImplementation  (v3)', 16)
text('registrar', 12, 38, 'ROLE: ERC-721 ledger of 2LDs — owns ALL of\n  being-an-NFT: enumeration, label index, metadata', 12)
text('registrar', 12, 80, 'STORES (key -> value):\n- ownerOf[tokenId]; balanceOf[owner]\n- expiries[tokenId] -> uint; grace period\n- labelOf[tokenId] -> 2LD label (write-once)\n- _ownedTokens[owner][i]; _allTokens[i]\n  (ERC721Enumerable indices)\n- controllers[addr] -> bool; baseNode\n- metadataRenderer (address, settable)', 11)
text('registrar', 12, 222, 'EXPOSES:\n- register(LABEL, owner, duration) onlyController\n  (API takes the plaintext label -> labelOf)\n- renew, ownerOf / transferFrom, nameExpires\n- balanceOf / tokenOfOwnerByIndex / totalSupply\n  (ERC721Enumerable -> trustless My Names)\n- labelOf(tokenId); name() / symbol()\n- tokenURI(tokenId) -> delegates to renderer\n  (NFT title = the domain name)\n- setMetadataRenderer (onlyOwner)', 11)
text('registrar', 12, 410, 'tokenId = uint256(keccak256(label)) = LABELHASH\n(the 2LD label only — NOT the namehash registry\nnode keccak256(tldNode, labelhash)).\nregister(label) hashes the label internally.', 10, { strokeColor: '#1971c2' })
text('registrar', 12, 470, 'enumeration via OpenZeppelin ERC721Enumerable;\nlabelOf + label-aware register + renderer hook\nare SNRC additions.', 10, { strokeColor: '#a15c00' })

box('subnames', 470, 380, '#ffec99', { strokeWidth: 2 })
text('subnames', 12, 10, 'SubnameRegistrar  (new, IMMUTABLE)', 16)
text('subnames', 12, 38, 'ROLE: create + index subnames\n  (subnames are registry nodes, NOT tokens)', 12)
text('subnames', 12, 80, 'STORES (key -> value):\n- labelOf[bytes32 labelhash] -> subname label\n- childrenOf[bytes32 parentNode] -> labelhash[]\n- childIndexed[bytes32 node] -> bool (dedup)', 11)
text('subnames', 12, 158, 'EXPOSES:\n- createSubname(parentNode, label)\n  (atomic; owner FORCED to parent owner;\n   needs registry.setApprovalForAll(this))\n- submitSubname(parentNode, label)\n  (permissionless backfill; hash+owner verified)\n- getChildren(parentNode, start, count)\n- childrenLength(parentNode)', 11)
text('subnames', 12, 318, 'IMMUTABLE: the operator-grant target can only\never create caller-owned subnodes. If redeployed,\nrebuild the index via submitSubname.', 10, { strokeColor: '#a15c00' })

box('registry', 350, 270, '#a5d8ff')
text('registry', 12, 10, 'ENSRegistry', 16)
text('registry', 12, 38, 'ROLE: the name tree — source of truth\n           for every node (incl. subnames)', 12)
text('registry', 12, 80, 'STORES (key -> value):\n- records[bytes32 node] -> {owner,resolver,ttl}\n  (node = namehash)', 11)
text('registry', 12, 130, 'EXPOSES:\n- owner / resolver / ttl / recordExists\n- setSubnodeOwner  (SNRC subnames go via\n  SubnameRegistrar.createSubname; direct\n  foreign-owned writes are unindexed/untrusted)\n- setResolver / setRecord / setOwner', 11)

box('metadata', 410, 250, '#ffec99', { strokeWidth: 2 })
text('metadata', 12, 10, 'OnchainMetadataRenderer  (settable)', 16)
text('metadata', 12, 38, 'ROLE: fully on-chain NFT metadata —\n           no server, no IPFS (swappable)', 12)
text('metadata', 12, 80, 'STORES:\n- static SVG artwork (bytecode constant,\n  same image for every name)', 11)
text('metadata', 12, 140, 'EXPOSES:\n- tokenURI(tokenId, label) ->\n  data:application/json;base64,{\n   name: "<label>.testing" (JSON-escaped),\n   description, image: data:image/svg+xml }', 11)

box('resolver', 350, 270, '#a5d8ff')
text('resolver', 12, 10, 'PublicResolver', 16)
text('resolver', 12, 38, 'ROLE: per-name records', 12)
text('resolver', 12, 64, 'STORES (key -> value):\n- texts[node][string key] -> string\n  (simplex.contact, simplex.channel, ...)\n- addrs[node][uint coinType] -> bytes\n- contenthash[node]; (node = namehash)', 11)
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
text('note', 12, 36, '2LDs trade as plain ERC-721 and self-serve enumeration + labels + metadata from the\nregistrar. Subnames are NOT tokens: created + indexed by the SubnameRegistrar, ALWAYS\nowned by the 2LD owner (hard-wired). Subgraph: optional (history only).', 11)

// ---------- legend ----------
box('legend', 290, 170, '#ffffff')
text('legend', 12, 10, 'LEGEND', 13)
const sw = (dy, c) => els.push(base({ type: 'rectangle',
  x: boxes.legend.x + 12, y: boxes.legend.y + dy, width: 18, height: 12,
  backgroundColor: c, roundness: { type: 3 }, groupIds: ['grp-legend'] }))
sw(36, '#ffec99'); text('legend', 38, 34, 'SNRC custom code', 11)
sw(58, '#b2f2bb'); text('legend', 38, 56, 'upstream ENS, modified', 11)
sw(80, '#a5d8ff'); text('legend', 38, 78, 'verbatim upstream ENS', 11)
sw(102, '#e9ecef'); text('legend', 38, 100, 'external', 11)
sw(124, '#d0bfff'); text('legend', 38, 122, 'actors', 11)

// ---------- keys & terms glossary ----------
box('keys', 470, 196, '#ffffff')
text('keys', 12, 10, 'KEYS & TERMS  (how storage is addressed)', 13)
text('keys', 12, 38, 'label        = a single name part, e.g. "alice"\nlabelhash    = keccak256(label)\nnode/namehash= keccak256(parentNode, labelhash)\ntldNode      = namehash("testing")\nparentNode   = node of the parent (2LD for a subname)\ntokenId      = labelhash of the 2LD (ERC-721 id)\ncommitment   = hash(label, owner, secret, ...)', 11)

// ---------- arrows ----------
arrow('user', 'controller', 'commit / register / renew')
arrow('user', 'registrar', 'My Names: tokenOfOwnerByIndex\n+ labelOf + tokenURI  (trustless)')
arrow('user', 'subnames', 'createSubname / submitSubname /\ngetChildren; setApprovalForAll(this)')
arrow('user', 'resolver', 'setText("simplex.contact", ...)')
arrow('wallets', 'registrar', 'ownerOf / tokenURI / transferFrom\n(self-contained, NFT title = name)')
arrow('clients', 'universal', 'resolve(alice.testing)')
arrow('multisig', 'registrar', 'admin: addController,\nsetMetadataRenderer (swap, auditable)', true)
arrow('controller', 'registrar', 'register(label) / renew\n(onlyController)')
arrow('controller', 'resolver', 'multicallWithNodeCheck\n(records at registration)')
arrow('controller', 'reverse', 'setNameForAddr (reverse record)')
arrow('controller', 'smpxnft', 'balanceOf (gate)')
arrow('controller', 'oracle', 'price()')
arrow('oracle', 'chainlink', 'ETH/USD')
arrow('subnames', 'registry', 'setSubnodeOwner (as operator);\nrecordExists / owner (verify)')
arrow('registrar', 'registry', 'setSubnodeOwner(TLD, labelhash)\non register / reclaim')
arrow('registrar', 'metadata', 'tokenURI delegates\n(tokenId, label) (view)')
arrow('universal', 'registry', 'owner / resolver')
arrow('universal', 'resolver', 'text / addr')

const doc = {
  type: 'excalidraw', version: 2, source: 'snrc-architecture-generator',
  elements: els, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {},
}
writeFileSync(new URL('./architecture-testing-v3.excalidraw', import.meta.url).pathname,
  JSON.stringify(doc, null, 1))
console.log('elements:', els.length)
