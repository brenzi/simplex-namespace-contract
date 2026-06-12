# SNRC happy flows — register, set record, subname, resolve

> Caution: this is not yet exactly as implemented and deployed

Companion to [`architecture-testing-v3.excalidraw`](./architecture-testing-v3.excalidraw)
(same components, wrapper-free v3 design). Six flows: register a bare name, attach the
`simplex.contact` record, create a subname, resolve the contact from a SimpleX chat
client, load the dApp's My Names view, and render the name-NFT in a generic wallet —
all on-chain reads are plain `eth_call`s against any Ethereum RPC.

## 1 — Register a bare name (commit-reveal, no records yet)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (dApp)
    participant C as SimplexController
    participant N as SMPXNFT
    participant O as PriceOracle
    participant B as BaseRegistrar v3
    participant R as ENSRegistry

    U->>C: commit(commitment)<br/>= hash(label, owner, secret, ...)
    note over U,C: wait at least minCommitmentAge (60 s)<br/>front-running protection
    U->>C: register("alice", owner,<br/>resolver=0, data=[]) + ETH
    C->>N: balanceOf(user) >= 1 ? (NFT gate)
    C->>O: price("alice", expires, duration)
    O-->>C: { base, premium }
    C->>B: register(labelhash, owner=user, duration)
    B->>R: setSubnodeOwner(tldNode, labelhash -> user)
    B-->>C: expiry
    note over C: stores labelOf["alice"],<br/>allLabels.push — issue 20 index
    note over U,B: ERC-721 minted directly to the user.<br/>alice.testing exists — no resolver, no records yet
```

## 2 — Set the simplex.contact record

```mermaid
sequenceDiagram
    autonumber
    actor U as User (dApp)
    participant R as ENSRegistry
    participant P as PublicResolver

    U->>R: setResolver(namehash("alice.testing"), PublicResolver)
    U->>P: setText(node, "simplex.contact", link)
    P->>R: owner(node) == caller ?  (isAuthorised)
    R-->>P: user — authorised
    note over P: record stored:<br/>alice.testing / simplex.contact -> link
```

## 3 — Create a subname (no attributes)

```mermaid
sequenceDiagram
    autonumber
    actor U as Alice (parent owner)
    participant R as ENSRegistry
    participant C as SimplexController

    U->>R: setSubnodeOwner(namehash("alice.testing"),<br/>labelhash("mobile"), bob)
    note over R: node mobile.alice.testing now owned by bob<br/>(parent-revocable: Alice can reassign anytime)
    U->>C: submitSubname(namehash("alice.testing"), "mobile")
    C->>R: recordExists(node) ?
    R-->>C: true
    note over C: childrenOf[alice.testing] += "mobile",<br/>labelOf["mobile"] — issue 20 index
```

## 4 — Resolution (SimpleX chat finds the contact by name)

```mermaid
sequenceDiagram
    autonumber
    actor S as SimpleX chat client
    participant UR as UniversalResolver
    participant R as ENSRegistry
    participant P as PublicResolver

    S->>UR: resolve("alice.testing", text("simplex.contact"))
    UR->>R: resolver(namehash("alice.testing"))
    R-->>UR: PublicResolver
    UR->>P: text(node, "simplex.contact")
    P-->>UR: simplex contact link
    UR-->>S: contact link — client connects
```

## 5 — dApp My Names view (indexer-free)

```mermaid
sequenceDiagram
    autonumber
    actor W as SNRC dApp — My Names (account 0xb51f...)
    participant C as SimplexController
    participant B as BaseRegistrar v3
    participant R as ENSRegistry
    participant P as PublicResolver
    participant M as OnchainMetadataService

    W->>C: allLabelsLength() + getLabels(0, pageSize)
    C-->>W: [labelhashes], [labels] — issue 20 index
    W->>B: ownerOf(lh) + nameExpires(lh) per candidate
    note over W,B: one eth_call, batched via Multicall3
    B-->>W: owners + expiries
    note over W: keep names where owner == 0xb51f...<br/>e.g. alice.testing
    W->>C: getChildren(namehash("alice.testing"), 0, pageSize)
    C-->>W: subnames, e.g. ["mobile"] (filter live: registry.owner != 0)
    W->>R: resolver(namehash("alice.testing"))
    R-->>W: PublicResolver
    W->>P: text(node, "simplex.contact"), addr(node)
    P-->>W: records for the profile view
    W->>B: tokenURI(labelhash("alice"))
    B->>M: tokenURI(labelhash) (view, delegates)
    M-->>W: data:application/json#59;base64<br/>name "alice.testing" + embedded SVG image
    note over W,M: zero indexers — every step is a free eth_call<br/>against any RPC, no getLogs
```

## 6 — Wallet (e.g. MetaMask) renders the name-NFT

```mermaid
sequenceDiagram
    autonumber
    actor W as MetaMask (account 0xb51f...)
    participant API as MetaMask NFT API (3rd-party indexer)
    participant B as BaseRegistrar v3
    participant M as OnchainMetadataService

    W->>API: NFTs owned by 0xb51f... ?
    API-->>W: contract BaseRegistrar,<br/>tokenId = labelhash("alice")
    note over W,API: wallet-side autodetection (MetaMask's own infra).<br/>Fallback: manual import of contract + tokenId
    W->>B: name() / symbol()
    B-->>W: collection header, e.g. "SimpleX Names"
    W->>B: ownerOf(tokenId) — confirm ownership
    W->>B: tokenURI(tokenId)
    B->>M: tokenURI(labelhash) (view, delegates)
    M-->>W: data:application/json#59;base64<br/>{ name: "alice.testing", image: embedded SVG }
    note over W: renders the NFT card: title + SVG.<br/>Subnames are NOT tokens — they never appear here
```

Notes:

- Flow 1 registers with `resolver = 0`: the registrar mints straight to the user and no
  registry record is set beyond ownership. (The dApp can also register with a resolver and
  records in one transaction — the controller then passes them through
  `multicallWithNodeCheck`; omitted here for clarity, as is the optional reverse record.)
- Flow 2 is the "edit profile" path: the resolver authorises the caller because the
  registry says they own the node.
- Flow 3 needs no controller, payment, gate, or expiry — subnames are plain registry
  entries created by the parent, revocable by the parent. The `submitSubname` indexing
  step is permissionless and optional-but-recommended (anyone can do it later; the dApp
  chains it automatically).
- Flow 4 uses the UniversalResolver one-call path; a client can equally do the two reads
  itself — `registry.resolver(node)`, then `resolver.text(node, "simplex.contact")` —
  which is what `scripts/resolver/snrc-resolve.py` does.
- Flow 5 is the owner→names question answered without any owner index: the issue-20
  `allLabels` array supplies the complete candidate set and live `ownerOf` filtering
  attributes them — O(total names in the TLD) view reads, batched. The account's primary
  name (reverse resolution via the ReverseRegistrar) is omitted for brevity.
- Flow 6: a generic wallet doesn't know the SNRC controller ABI, so its *discovery* step
  runs through the wallet vendor's own NFT indexer (centralized, outside SNRC's control)
  or manual import — only the rendering path (`tokenURI` → data URI with embedded SVG) is
  trustless. Subnames are not tokens in the wrapper-free design, so wallets never list
  them — by design; they are visible in the dApp via `getChildren` (flow 5).
