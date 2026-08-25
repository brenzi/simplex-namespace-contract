# Architecture

SimpleX Namespace Registry Contract (SNRC) is a fork of [ENS](https://ens.domains)
adapted for SimpleX Chat. It maps human-readable names (`alice.simplex`,
`bob.testing`) to SimpleX contact and channel short links.

The full design rationale lives in
[`snrc-implementation-plan.md`](../snrc-implementation-plan.md). This document
gives the operational picture an integrator or auditor needs. For a
plain-language summary of how SNRC differs from ENS, see
[`ens-diff.md`](./ens-diff.md).

---

## Components

```
      ┌────────────────────────────┐
      │ ENSRegistry  (verbatim)    │  owner + resolver of every node
      └──────────────┬─────────────┘
                     │
                     ▼
      ┌────────────────────────────┐   tokenURI   ┌────────────────────────────┐
      │ BaseRegistrar v3           │─────────────▶│ MetadataRenderer           │
      │ ERC-721 + Enumerable,      │              │ on-chain JSON + SVG        │
      │ labelOf · tokenURI         │              └────────────────────────────┘
      └──────────────┬─────────────┘
                     │ controllers
                     ▼
      ┌────────────────────────────┐   records    ┌────────────────────────────┐
      │ SimplexController          │─────────────▶│ PublicResolver (verbatim)  │
      │ (UUPS proxy)               │              │ text: simplex.contact,     │
      └──────────────┬─────────────┘              │ simplex.channel            │
                     │ price()                    └────────────────────────────┘
                     ▼
      ┌────────────────────────────┐
      │ Price oracle               │
      │ DummyOracle / Chainlink    │
      └────────────────────────────┘

  register() enforces:  minCharLength · reservedNames · nftGate
  admin:  setMinCharLength · addReservedNames · disableNftGate · registerReserved

  SubnameRegistrar (immutable) — owns + indexes registry subnodes, soulbound to the
  2LD NFT; it is also the PublicResolver's nameWrapper slot (subname auth via ownerOf).
```

`ENSRegistry`, `Root`, `PublicResolver`, `StringUtils`,
`StablePriceOracle`, `ExponentialPremiumPriceOracle`, `UniversalResolver`, and the
price-oracle interfaces are vendored verbatim from ENS. `SimplexController` is custom
(UUPS); `BaseRegistrarImplementation` is modified (v3 — ERC721Enumerable + `labelOf`
label index + `tokenURI`); `MetadataRenderer` (swappable) and `SubnameRegistrar`
(immutable) are new SNRC contracts. **There is no NameWrapper** — only the
`INameWrapper` interface is kept, because verbatim `PublicResolver` imports it
(deployed with `nameWrapper = SubnameRegistrar`, so subname records authorise via
`SubnameRegistrar.ownerOf`). **There is no reverse registrar either** — removed in
names-v2: `.simplex` maps names to SimpleX links in one direction and nothing resolves an
address back to a name, so `ReverseRegistrar` and `DefaultReverseRegistrar` are not
deployed, `PublicResolver` no longer inherits `ReverseClaimer`, and a registration
carrying a `reverseRecord` bit reverts `ReverseRecordNotSupported`. The controller's two
former slots are reserved, not deleted, so it can be reintroduced without a layout
migration. See the per-file diff in the plan.

## TLD strategy

There is **one deployment per TLD**. Each is an independent ENS-shaped stack
(`ENSRegistry → BaseRegistrar v3 → SimplexController + PublicResolver +
MetadataRenderer + SubnameRegistrar + Root`). The TLDs:

| TLD        | NFT gate             | Min chars | Launch |
|------------|----------------------|-----------|--------|
| `.testing` | enabled → **lifted** | 6 → 3     | first  |
| `.simplex` | disabled             | 6 → 3     | later  |

`.testing` launched NFT-gated; the gate was disabled on-chain on 2026-07-09
(`disableNftGate`, one-way), so `.testing` registration is now open — and with an
all-zero price oracle it is also free. `.simplex` shares the same
`SimplexController` source but constructs it with `smpxNft = address(0)` and
`nftGateEnabled = false`, so its NFT-gate code path is dead from the start.

## Data flow: register

```
User → SimplexController.commit(hash)
     → wait 60s (minCommitmentAge)
     → SimplexController.register{value: price}(Registration)
       ├─ _checkSimplexGates(label)             ← NEW
       │   ├─ require(label.strlen ≥ minCharLength)
       │   ├─ require(!reservedNames[hash(label)])
       │   └─ if nftGateEnabled: require(smpxNft.balanceOf(sender) > 0)
       ├─ priceOracle.price(...)               ← unchanged from ENS
       ├─ require(msg.value ≥ totalPrice)      ← unchanged
       ├─ commit-reveal age check              ← unchanged
       ├─ base.registerWithLabel(label, owner, duration)  ← v3: passes the
       │      plaintext label so the registrar records labelOf (hash→name)
       ├─ ens.setRecord(node, owner, resolver, 0)    ← unchanged (if resolver ≠ 0)
       ├─ resolver.multicallWithNodeCheck(...)        ← unchanged
       ├─ base.transferFrom(this, owner, labelhash)  ← unchanged
       └─ refund excess ETH                            ← unchanged

   (the reverse-record branch is gone — names-v2 removed reverse resolution, and
    makeCommitment now rejects any non-zero reverseRecord up front)
```

New vs ENS's `ETHRegistrarController.register`: the `_checkSimplexGates` line, and
`base.registerWithLabel(label,…)` in place of `base.register(labelhash,…)` so the
registrar records the on-chain label index. Everything else is identical.

## SimpleX data on-chain

We use ENS's `PublicResolver` verbatim. SimpleX links are stored as text
records:

| Key                | Use                                       |
|--------------------|-------------------------------------------|
| `simplex.contact`  | SimpleX 1:1 contact short link            |
| `simplex.channel`  | SimpleX channel short link                |

Each of these stores a comma-separated list of URLs (primary first,
fallbacks after) so a name can advertise multiple SMP servers for
redundancy. Clients SHOULD try the URLs in order. The on-chain layer
remains a single text-record string; the dApp and any resolver client
share an identical parse rule (split on `,`, trim, drop empties) so the
two sides round-trip cleanly. The dApp's editor caps the list at 5 entries; the
on-chain record itself is unconstrained.

The frontend renders both as first-class social profile entries with the
SimpleX logo; see `supportedSocialRecordKeys.ts`, `getSocialData.ts`,
`parseSimplexUrls.ts`, and the click-to-expand `MultiUrlField`.

## Subnames & NFT metadata (wrapper-free)

There is no NameWrapper. Instead:

- **2LDs are plain ERC-721** on the `BaseRegistrar` and trade directly. The
  registrar adds `ERC721Enumerable` (trustless "My Names"), a write-once
  `labelOf` index (`registerWithLabel`), and `tokenURI` that delegates to the
  swappable **`MetadataRenderer`**, which builds the JSON + SVG (with the domain
  name) fully on-chain — no off-chain metadata service.
- **Subnames** are created + indexed by the immutable **`SubnameRegistrar`**,
  which *owns* the subname registry nodes and makes them **soulbound to the 2LD
  NFT**: a subname's effective owner is derived on read by `ownerOf` (it walks
  the `parentOf` chain up to the 2LD node, whose registry owner the BaseRegistrar
  **auto-reclaim** hook keeps equal to the token holder). So subnames follow the
  NFT automatically and are never independently transferable; enumerable via
  `getChildren` without an indexer. Re-registering an expired 2LD bumps a
  per-2LD `generation` via BaseRegistrar's **`onReregister`** hook, retiring all
  old subnames at once (lazy `purge` frees their storage). Users grant
  `registry.setApprovalForAll(subnameRegistrar, true)` before their first subname.
  See [`sequence-happy-flow.md`](./sequence-happy-flow.md) flows 3 & 7.

## Upgrade story

Only `SimplexController` is upgradeable — it sits behind an ERC-1967 proxy and
uses UUPS (`_authorizeUpgrade` gated on owner). Every other contract is
**immutable**: `ENSRegistry`, `BaseRegistrar` (v3), `MetadataRenderer`,
`SubnameRegistrar`, resolver, oracles. The two seams that avoid needing a
registrar redeploy: `MetadataRenderer` is swapped via
`baseRegistrar.setMetadataRenderer(...)`, and the `SubnameRegistrar` index is
reconstructible by re-creating subnames if it is ever redeployed.

## Pricing

USD-denominated, paid in ETH via a Chainlink-style oracle. We reuse ENS's
`StablePriceOracle` and `ExponentialPremiumPriceOracle` (Dutch auction for
expired names) verbatim.

| Length | Annual price |
|--------|-------------|
| 6+     | $1          |
| 5      | $8          |
| 4      | $32         |
| 3      | $128        |

For local dev, we use ENS's `DummyOracle` (fixed ETH/USD = $1). On mainnet we
point the oracle at the live Chainlink ETH/USD feed. The table above is the
`.simplex` production curve; the live `.testing` deployment uses an all-zero
oracle, so registration there is **free**.

## Admin authority

`SimplexController` exposes admin functions to the deploy owner:

| Function                         | Bounds                                      |
|----------------------------------|---------------------------------------------|
| `setMinCharLength(uint8)`        | monotonic decrease only (6 → 5 → 4 → 3)     |
| `disableNftGate()`               | one-way (true → false)                      |
| `addReservedNames(string[])`     | bulk; ~1000 names per tx                    |
| `removeReservedNames(string[])`  | bulk; ~1000 names per tx                    |
| `registerReserved(string,address,uint256)` | bypasses gates                    |

The owner can renounce admin authority once the TLD is stable.

## Frontend

The dApp is a fork of `ens-app-v3`. Surgical changes only:

- `SimplexController` ABI hot-spots: `useEstimateRegistration`,
  `useSimulateRegistration`, `useExistingCommitment`, registration tx builders.
- New components: `SimplexInfoPanel`, `useControllerLimits`, `useNftGateStatus`,
  `pages/admin.tsx`.
- New social records: `simplex.contact`, `simplex.channel`.
- Logo: `assets/SimplexFull.svg`, `assets/SimplexWithGradient.svg`,
  `assets/social/SocialSimplex.svg`.

The full per-file diff against `ensdomains/ens-app-v3` is the audit surface.

## Deployment targets

| Network | Provider              | NFT contract                                  | Oracle                                  |
|---------|-----------------------|-----------------------------------------------|------------------------------------------|
| local   | Hardhat node          | `MockSMPXNFT`                                 | `DummyOracle` (fixed $1/ETH)             |
| Mainnet | Ethereum              | `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291` | Chainlink ETH/USD                        |

See [`deployment.md`](./deployment.md) for the per-network checklist.

## Source layout

```
simplex-namespace-contract/      ← parent repo (this)
  ens-contracts/                 ← submodule (Solidity)
    contracts/
      simplex/SimplexController.sol      ← new (UUPS)
      simplex/SimplexControllerProxy.sol ← new (ERC1967 proxy)
      simplex/MetadataRenderer.sol       ← new (on-chain NFT JSON+SVG)
      simplex/SubnameRegistrar.sol       ← new (subname create + index)
      ethregistrar/BaseRegistrarImplementation.sol ← modified (v3: enumerable,
                                            labelOf, tokenURI, registerWithLabel)
      mocks/MockSMPXNFT.sol              ← new
      mocks/Multicall3.sol               ← new (aggregate3 + tryAggregate)
      wrapper/INameWrapper.sol           ← kept (interface only, for PublicResolver)
      …all other contracts verbatim from ENS (NameWrapper removed)
  ens-app-v3/                    ← submodule (frontend)
    src/components/SimplexInfoPanel.tsx
    src/hooks/useControllerLimits.ts
    src/hooks/useNftGateStatus.ts
    src/pages/admin.tsx
    src/constants/supportedSocialRecordKeys.ts (extended)
    …rest of ENS app, lightly patched
  scripts/
    deploy-local.mjs             ← parameterized by SIMPLEX_TLD env var
    run-local.sh                 ← orchestrates node + deploy + frontend
  test/e2e/simplex-flow.spec.ts  ← 25 Playwright tests
  docs/                          ← this directory
```
