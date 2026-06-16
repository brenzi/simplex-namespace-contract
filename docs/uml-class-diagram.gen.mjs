// Generates docs/uml-class-diagram.excalidraw — UML-ish class diagram of the
// wrapper-free v3 contracts: storage (with mapping keys), public function
// signatures, and dependency / realization arrows.
//
//   node docs/uml-class-diagram.gen.mjs
//
// Edit POS to rearrange; text is box-relative; arrows auto-route edge-to-edge
// and are bound to boxes, so everything stays attached when dragged.
import { writeFileSync } from 'fs'

// Positions reflect the manual arrangement in
const POS = {
  title:      [-372, -80],
  legend:     [-357, -47],
  reverse:    [-632, 280],
  registry:   [675, 607],
  resolver:   [791, 69],
  controller: [-40, 240],
  registrar:  [598, 892],
  subnames:   [608, 256],
  oracle:     [-593, 587],
  smpxnft:    [-462, 28],
  metadata:   [-105, 984],
  chainlink:  [-560, 800],
  ifaces:     [-64, 695],
}

// Hand-tuned arrow geometry
const GEOM = {
  "controller->registrar": { x: 372.74, y: 656, points: [[0,0],[332.94,230.1]] },
  "controller->registry": { x: 486, y: 503.16, points: [[0,0],[230.22,97.93]] },
  "controller->resolver": { x: 483.46, y: 255.43, points: [[0,0],[132.9,-67.91],[302.32,-110.21]] },
  "controller->oracle": { x: -40, y: 499.57, points: [[0,0],[-207.48,87.43]] },
  "controller->smpxnft": { x: -13.85, y: 240, points: [[0,0],[-205.79,-132]] },
  "controller->reverse": { x: -40, y: 364.69, points: [[0,0],[-162,-15.77]] },
  "oracle->chainlink": { x: -378.59, y: 749, points: [[0,0],[-1.11,51]] },
  "registrar->registry": { x: 862.83, y: 886.1, points: [[0,0],[44.16,-124.02]] },
  "registrar->metadata": { x: 592.16, y: 1051.67, points: [[0,0],[-171.17,-2.1]] },
  "subnames->registry": { x: 882.67, y: 492.18, points: [[0,0],[13.13,108.9]] },
  "resolver->registry": { x: 1166.8, y: 224.34, points: [[0,0],[2.3,323.38],[-32.69,389.58]] },
}

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
const boxes = {}

const box = (key, w, h, bg, extra = {}) => {
  const [x, y] = POS[key]
  const gid = `grp-${key}`
  const r = base({ id: `box-${key}`, type: 'rectangle', x, y, width: w, height: h,
    backgroundColor: bg, roundness: { type: 3 }, groupIds: [gid], boundElements: [], ...extra })
  els.push(r); boxes[key] = r
  return key
}
const text = (key, dx, dy, str, size = 11, extra = {}) => {
  const [bx, by] = key ? [boxes[key].x, boxes[key].y] : [0, 0]
  const lines = str.split('\n')
  const w = Math.max(...lines.map((l) => l.length)) * size * 0.6
  const h = lines.length * size * 1.25
  els.push(base({ type: 'text', x: bx + dx, y: by + dy, width: w, height: h, text: str,
    fontSize: size, fontFamily: 3, textAlign: 'left', verticalAlign: 'top',
    containerId: null, originalText: str, autoResize: true, lineHeight: 1.25,
    groupIds: key ? [`grp-${key}`] : [], ...extra }))
}
// horizontal divider inside a class box (UML compartment separator)
const divider = (key, dy, w) => els.push(base({ type: 'line', x: boxes[key].x, y: boxes[key].y + dy,
  width: w, height: 0, points: [[0, 0], [w, 0]], groupIds: [`grp-${key}`], strokeColor: '#888' }))

const edge = (r, tx, ty) => {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2
  const dx = tx - cx, dy = ty - cy
  const t = Math.min(dx !== 0 ? Math.abs(r.width / 2 / dx) : Infinity,
    dy !== 0 ? Math.abs(r.height / 2 / dy) : Infinity)
  return [cx + dx * t, cy + dy * t]
}
// kind: 'dep' (solid, calls) | 'impl' (dashed, realization).
// Uses hand-tuned geometry from GEOM (bends + endpoints) when present; else
// falls back to straight edge-to-edge routing.
const arrow = (fromKey, toKey, label, kind = 'dep') => {
  const A = boxes[fromKey], B = boxes[toKey]
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
    strokeStyle: kind === 'impl' ? 'dashed' : 'solid', roundness: { type: 2 },
    points: pts, lastCommittedPoint: null,
    startBinding: { elementId: A.id, focus: 0, gap: 4 },
    endBinding: { elementId: B.id, focus: 0, gap: 4 },
    startArrowhead: null, endArrowhead: kind === 'impl' ? 'triangle' : 'arrow',
    elbowed: false, boundElements: [] })
  els.push(a)
  A.boundElements.push({ id: a.id, type: 'arrow' })
  B.boundElements.push({ id: a.id, type: 'arrow' })
  if (label) {
    const fs = 9
    const w = label.length * fs * 0.6, h = fs * 1.25
    const mx = x1 + (pts[0][0] + pts[pts.length - 1][0]) / 2
    const my = y1 + (pts[0][1] + pts[pts.length - 1][1]) / 2
    const t = base({ id: id('lbl'), type: 'text', x: mx - w / 2, y: my - h / 2,
      width: w, height: h, text: label, fontSize: fs, fontFamily: 3, textAlign: 'center',
      verticalAlign: 'middle', containerId: a.id, originalText: label, autoResize: true,
      lineHeight: 1.25, strokeColor: '#555' })
    els.push(t); a.boundElements.push({ id: t.id, type: 'text' })
  }
}

const C = { custom: '#ffec99', v3: '#b2f2bb', upstream: '#a5d8ff', external: '#e9ecef', iface: '#f3d9fa' }
const DS = '#e8590c' // deployment-specific deploy value (varies per TLD / network)

// ---------- title + legend ----------
text(null, POS.title[0], POS.title[1], 'SNRC v3 — contract class diagram (storage keys + function signatures)', 20)
box('legend', 1040, 26, '#ffffff')
text('legend', 10, 6, 'yellow = SNRC custom   |   green = upstream + v3 diff   |   blue = verbatim upstream   |   violet = interface catalog   |   gray = external   |   →  calls   (realized interfaces are listed in each box title: "is …")', 10)
text(null, POS.legend[0], -14, 'orange text = deploy-time value (mainnet .testing); deployment-specific (varies per TLD / network)', 10, { strokeColor: DS })

// ========== SimplexController ==========
box('controller', 520, 410, C.custom, { strokeWidth: 2 })
text('controller', 10, 8, 'SimplexController   «UUPS proxy»', 13)
divider('controller', 30, 520)
text('controller', 10, 36, 'storage:\n  base : BaseRegistrarImplementation\n  prices : IPriceOracle   ens : ENS\n  commitments : mapping(bytes32 commitment => uint256 ts)\n  reservedNames : mapping(bytes32 labelhash => bool)\n  tldNode : bytes32   tldSuffix : string   minCharLength : uint8\n  smpxNft : SMPXNFT   nftGateEnabled : bool\n  minCommitmentAge / maxCommitmentAge : uint256\n  priceOracleFrozen : bool   treasury : address', 10)
divider('controller', 168, 520)
text('controller', 10, 174, 'functions:\n  initialize(base, prices, …, config, owner)\n  commit(bytes32 commitment)\n  register(Registration) payable\n  renew(string label, uint256 duration, bytes32 referrer) payable\n  registerReserved(string, address, uint256)\n  addReservedNames(string[]) / removeReservedNames(string[])\n  rentPrice(string,uint256) / available(string) / valid(string)\n  setMinCharLength / disableNftGate / setPriceOracle / freezePriceOracle\n  setTreasury / withdraw / _authorizeUpgrade(onlyOwner)', 10)

divider('controller', 302, 520)
text('controller', 10, 308, 'deploy config (.testing):', 10)
text('controller', 10, 321, 'minCommitmentAge 60s · maxCommitmentAge 86400s (24h)', 10)
text('controller', 10, 334, 'tldSuffix ".testing"  ·  minCharLength 6', 10, { strokeColor: DS })
text('controller', 10, 347, 'nftGateEnabled true', 10, { strokeColor: DS })
text('controller', 10, 360, 'smpxNft 0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291', 10, { strokeColor: DS })
text('controller', 10, 373, 'cold owner simplexchat.eth (0xDa06…0340)', 10, { strokeColor: DS })
text('controller', 10, 386, 'reserved simplex, simplex-chat', 10, { strokeColor: DS })

// ========== BaseRegistrarImplementation v3 ==========
box('registrar', 540, 360, C.v3, { strokeWidth: 2 })
text('registrar', 10, 8, 'BaseRegistrarImplementation  v3\n  is ERC721Enumerable, IBaseRegistrar, Ownable', 12)
divider('registrar', 44, 540)
text('registrar', 10, 50, 'storage:\n  expiries : mapping(uint256 tokenId => uint256)\n  labelOf : mapping(uint256 tokenId => string)   (tokenId = labelhash)\n  metadataRenderer : address   maxLabelLength : uint256 (0=∞)\n  controllers : mapping(address => bool)\n  ens : ENS   baseNode : bytes32\n  _ownedTokens / _allTokens (ERC721Enumerable)', 10)
divider('registrar', 162, 540)
text('registrar', 10, 168, 'functions:\n  registerWithLabel(string label, address owner, uint256 dur)\n  register(uint256 id, …) / registerOnly(…)  (upstream, no label)\n  renew(uint256,uint256) / reclaim(uint256,address)\n  ownerOf / nameExpires / available(uint256)\n  balanceOf / tokenOfOwnerByIndex / totalSupply / tokenByIndex\n  tokenURI(uint256) / labelOf(uint256)\n  setMetadataRenderer(address) / setMaxLabelLength(uint256) (onlyOwner)\n  addController / removeController / setResolver (onlyOwner)', 10)

divider('registrar', 290, 540)
text('registrar', 10, 296, 'deploy config (.testing):', 10)
text('registrar', 10, 309, 'maxLabelLength 63   (DNS octet limit)', 10)
text('registrar', 10, 322, 'baseNode namehash(".testing")', 10, { strokeColor: DS })

// ========== MetadataRenderer ==========
box('metadata', 520, 152, C.custom, { strokeWidth: 2 })
text('metadata', 10, 8, 'MetadataRenderer   «swappable»\n  is IMetadataRenderer', 12)
divider('metadata', 44, 520)
text('metadata', 10, 50, 'storage:  suffix : string  (e.g. ".testing")', 10)
divider('metadata', 70, 520)
text('metadata', 10, 76, 'functions:\n  constructor(string suffix)\n  tokenURI(uint256, string label) → data:application/json;base64 (JSON + SVG)', 10)

divider('metadata', 118, 520)
text('metadata', 10, 124, 'deploy (.testing):  suffix = ".testing"', 10, { strokeColor: DS })

// ========== SubnameRegistrar ==========
box('subnames', 520, 230, C.custom, { strokeWidth: 2 })
text('subnames', 10, 8, 'SubnameRegistrar   «immutable»\n  is ISubnameRegistrar', 12)
divider('subnames', 44, 520)
text('subnames', 10, 50, 'storage:\n  ens : ENS (immutable)\n  labelOf : mapping(bytes32 labelhash => string)\n  childIndexed : mapping(bytes32 node => bool)\n  _children : mapping(bytes32 parentNode => bytes32[])', 10)
divider('subnames', 138, 520)
text('subnames', 10, 144, 'functions:\n  constructor(ENS)\n  createSubname(bytes32 parentNode, string label) → node\n  submitSubname(bytes32 parentNode, string label)\n  getChildren(bytes32 parent, uint256 start, uint256 count)\n  childrenLength(bytes32 parent)', 10)

// ========== ENSRegistry ==========
box('registry', 460, 150, C.upstream)
text('registry', 10, 8, 'ENSRegistry   «verbatim»', 12)
divider('registry', 30, 460)
text('registry', 10, 36, 'storage:\n  records : mapping(bytes32 node => {owner,resolver,ttl})\n  operators : mapping(owner => mapping(operator => bool))', 10)
divider('registry', 86, 460)
text('registry', 10, 92, 'functions:\n  setSubnodeOwner / setResolver / setRecord / setOwner\n  owner / resolver / ttl / recordExists / setApprovalForAll', 10)

// ========== PublicResolver ==========
box('resolver', 480, 150, C.upstream)
text('resolver', 10, 8, 'PublicResolver   «verbatim»', 12)
divider('resolver', 30, 480)
text('resolver', 10, 36, 'storage:\n  versionable_texts : node => key(string) => string\n  versionable_addresses : node => coinType(uint) => bytes\n  nameWrapper : INameWrapper  (deployed as address(0))', 10)
divider('resolver', 86, 480)
text('resolver', 10, 92, 'functions:\n  setText / text / setAddr / addr / multicallWithNodeCheck\n  isAuthorised(node) [owner | operator | trustedETHController]', 10)

// ========== PriceOracle ==========
box('oracle', 430, 162, C.upstream)
text('oracle', 10, 8, 'ExponentialPremiumPriceOracle   «verbatim»\n  is IPriceOracle', 11)
divider('oracle', 42, 430)
text('oracle', 10, 48, 'functions:  price(string,uint256 expires,uint256 dur)\n             → Price{base, premium}', 10)

divider('oracle', 90, 430)
text('oracle', 10, 96, 'deploy config (.testing):', 10)
text('oracle', 10, 109, 'premium 1e26 start · 21-day halving', 10)
text('oracle', 10, 122, 'ETH/USD feed 0x5f4e…8419 (Chainlink)', 10, { strokeColor: DS })
text('oracle', 10, 135, 'base prices 0 — free, every length', 10, { strokeColor: DS })

// ========== Reverse ==========
box('reverse', 430, 96, C.upstream)
text('reverse', 10, 8, 'ReverseRegistrar + DefaultReverseRegistrar   «verbatim»', 10)
divider('reverse', 34, 430)
text('reverse', 10, 40, 'functions:  setNameForAddr(addr, owner, resolver, name)\n             claim / setName', 10)

// ========== SMPXNFT ==========
box('smpxnft', 360, 80, C.external)
text('smpxnft', 10, 8, 'SMPXNFT   «external ERC-721»', 11)
divider('smpxnft', 30, 360)
text('smpxnft', 10, 36, 'functions:  balanceOf(address) → uint256', 10)

// ========== Chainlink ==========
box('chainlink', 360, 56, C.external)
text('chainlink', 10, 8, 'Chainlink ETH/USD feed   «external»', 11)
text('chainlink', 10, 30, 'latestRoundData()', 10)

// ========== Interfaces ==========
box('ifaces', 360, 250, C.iface)
text('ifaces', 10, 8, '«interface catalog» (reference only)', 12)
divider('ifaces', 30, 360)
text('ifaces', 10, 36, 'realized by their own contract (see "is …"):\n  IMetadataRenderer  ← MetadataRenderer\n    tokenURI(uint256, string) → string\n  ISubnameRegistrar  ← SubnameRegistrar\n    createSubname / submitSubname /\n    getChildren / childrenLength / labelOf\n\nupstream interfaces:\n  IBaseRegistrar ← BaseRegistrar\n  IETHRegistrarController ← SimplexController\n  IPriceOracle ← price oracle\n  INameWrapper (kept only for PublicResolver)', 10)


// ---------- dependencies (calls) ----------
arrow('controller', 'registrar', 'registerWithLabel / renew / transferFrom')
arrow('controller', 'registry', 'setRecord')
arrow('controller', 'resolver', 'multicallWithNodeCheck')
arrow('controller', 'oracle', 'price()')
arrow('controller', 'smpxnft', 'balanceOf (gate)')
arrow('controller', 'reverse', 'setNameForAddr')
arrow('oracle', 'chainlink', 'ETH/USD')
arrow('registrar', 'registry', 'setSubnodeOwner')
arrow('registrar', 'metadata', 'tokenURI(id, labelOf[id])')
arrow('subnames', 'registry', 'setSubnodeOwner / owner / recordExists')
arrow('resolver', 'registry', 'owner / isAuthorised')

const doc = { type: 'excalidraw', version: 2, source: 'snrc-uml-class',
  elements: els, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} }
writeFileSync(new URL('./uml-class-diagram.excalidraw', import.meta.url).pathname, JSON.stringify(doc, null, 1))
console.log('elements:', els.length)
