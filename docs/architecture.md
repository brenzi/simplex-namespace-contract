# Architecture

SimpleX Namespace Registry Contract (SNRC) is a fork of [ENS](https://ens.domains)
adapted for SimpleX Chat. It maps human-readable names (`alice.simplex`,
`bob.testing`) to SimpleX contact and channel short links.

The full design rationale lives in
[`snrc-implementation-plan.md`](../snrc-implementation-plan.md). This document
gives the operational picture an integrator or auditor needs.

---

## Components

```
                ┌──────────────────────┐
                │ ENSRegistry (UUPS)   │ ◄─── owner of every node
                └──────────┬───────────┘
                           │ owner(node) / resolver(node)
                ┌──────────┴───────────┐
                │ BaseRegistrar (UUPS) │ ◄─── ERC-721, tokenId = labelhash
                └──────────┬───────────┘
                           │ controllers
        ┌──────────────────┴──────────────────┐
        │                                      │
┌───────┴────────────┐                ┌────────┴───────────┐
│ SimplexController  │ ── PublicResolver ──── DummyOracle / Chainlink
└────────────────────┘                └────────────────────┘
        │
        ├─ minCharLength            ── enforced in register()
        ├─ reservedNames            ── enforced in register()
        ├─ smpxNft + nftGateEnabled ── enforced in register() (.testing only)
        └─ admin functions          ── setMinCharLength, addReservedName,
                                       disableNftGate, registerReserved
```

`NameWrapper`, `ReverseRegistrar`, `Root`, `PublicResolver`, `StringUtils`,
`StablePriceOracle`, `ExponentialPremiumPriceOracle`, and the price-oracle
interfaces are vendored verbatim from ENS — we only deploy them with our
parameters. See the **change justification** table in the implementation plan
for a per-file diff.

## TLD strategy

There is **one deployment per TLD**. Each is an independent ENS-shaped stack
(`ENSRegistry → BaseRegistrar → SimplexController + PublicResolver + NameWrapper +
Root + ReverseRegistrar`). The TLDs:

| TLD        | NFT gate | Min chars | Launch |
|------------|----------|-----------|--------|
| `.testing` | enabled  | 6 → 3     | first  |
| `.simplex` | disabled | 6 → 3     | later  |

Both TLDs share the same `SimplexController` source. `.simplex` constructs it
with `smpxNft = address(0)` and `nftGateEnabled = false`, making the NFT-gate
code path dead.

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
       ├─ base.register(labelhash, owner, duration)  ← unchanged
       ├─ ens.setRecord(node, owner, resolver, 0)    ← unchanged (if resolver ≠ 0)
       ├─ resolver.multicallWithNodeCheck(...)        ← unchanged
       ├─ base.transferFrom(this, owner, labelhash)  ← unchanged
       ├─ reverseRegistrar.setNameForAddr(...)        ← unchanged (if bit set)
       └─ refund excess ETH                            ← unchanged
```

Only the `_checkSimplexGates` line is new. Everything else is identical to
ENS's `ETHRegistrarController.register`.

## SimpleX data on-chain

We use ENS's `PublicResolver` verbatim. SimpleX links are stored as text
records:

| Key                | Use                                       |
|--------------------|-------------------------------------------|
| `simplex.contact`  | SimpleX 1:1 contact short link            |
| `simplex.channel`  | SimpleX channel short link                |

The frontend renders both as first-class social profile entries with the
SimpleX logo; see `supportedSocialRecordKeys.ts` and `getSocialData.ts`.

## Upgrade story

`ENSRegistry` and `BaseRegistrar` are deployed behind ERC-1967 proxies and
use the UUPS pattern (`_authorizeUpgrade` gated on owner). The controller is
intentionally non-upgradeable — upgrades happen by deploying a new controller
and `addController()` / `removeController()` on the base registrar.

**NameWrapper is not UUPS-wrapped.** Its bytecode is already 25.9KB — over the
EIP-170 24,576-byte limit before any wrapper boilerplate. Migration, if ever
needed, uses ENS's existing `upgradeContract` hook on the wrapper itself.

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

For local dev, we use ENS's `DummyOracle` (fixed ETH/USD = $1). On Hoodi and
mainnet we point the oracle at the live Chainlink feed.

## Admin authority

`SimplexController` exposes admin functions to the deploy owner:

| Function                         | Bounds                                      |
|----------------------------------|---------------------------------------------|
| `setMinCharLength(uint8)`        | monotonic decrease only (6 → 5 → 4 → 3)     |
| `disableNftGate()`               | one-way (true → false)                      |
| `addReservedName(string)`        |                                             |
| `removeReservedName(string)`     |                                             |
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
| Hoodi   | Hoodi testnet         | `MockSMPXNFT` deployed once                   | `DummyOracle`                            |
| Mainnet | Ethereum              | `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291` | Chainlink ETH/USD                        |

See [`deployment.md`](./deployment.md) for the per-network checklist.

## Source layout

```
simplex-namespace-contract/      ← parent repo (this)
  ens-contracts/                 ← submodule (Solidity)
    contracts/
      simplex/SimplexController.sol      ← new
      mocks/MockSMPXNFT.sol              ← new
      mocks/Multicall3.sol               ← new (aggregate3 + tryAggregate)
      registry/ENSRegistry.sol           ← UUPS-wrapped
      ethregistrar/BaseRegistrarImplementation.sol ← UUPS-wrapped
      …all other contracts verbatim from ENS
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
  test/e2e/simplex-flow.spec.ts  ← 14 Playwright tests
  docs/                          ← this directory
```
