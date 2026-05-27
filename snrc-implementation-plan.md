# SNRC Implementation Plan: SimpleX Namespace Registry Contract

## Table of Contents

1. [Context](#context)
2. [Executive Summary](#executive-summary)
3. [Architecture](#architecture)
4. [Phases](#phases)
   - Phase 1: Fork repos + scaffolding
   - Phase 2: Mock contracts
   - Phase 3: Core registry (ENS fork)
   - Phase 4: Resolver (ENS PublicResolver, verbatim)
   - Phase 5: Base registrar (ERC-721 per TLD)
   - Phase 6: Controller (commit-reveal + pricing + gates)
   - Phase 7: NameWrapper (ERC-1155)
   - Phase 8: Reverse registrar + Root
   - Phase 9: Deployment scripts
   - Phase 10: Test suite
   - Phase 11: Frontend dApp
   - Phase 12: Playwright e2e
   - Phase 13: Documentation
5. [Verification](#verification)

---

## Context

SimpleX Chat needs a decentralized namespace registry (SNRC) mapping human-readable names (`alice.simplex`) to SimpleX short link data on Ethereum. The whitepaper (§Public Namespaces) specifies ENS as the model. This project forks the full ENS contract suite and adapts it for SimpleX's requirements: two TLDs, NFT-gated registration, reserved names, length restrictions, and UUPS upgradeability. Payment is ETH (same as ENS).

Existing assets to reuse:
- Solidity 0.8.24 + Hardhat toolchain already installed on this machine
- Whitepaper at `/work/community-credits-whitepaper/`

---

## Repository strategy

We work on public GitHub forks of the original ENS repos. This ensures `git diff` against upstream is always trivially available for auditors.

### Repos

| Repo | Upstream | Content |
|------|----------|---------|
| [`simplex-network/ens-contracts`](https://github.com/simplex-network/ens-contracts) | `ensdomains/ens-contracts` | All Solidity contracts, tests, deployment scripts, mocks |
| [`simplex-network/ens-app-v3`](https://github.com/simplex-network/ens-app-v3) | `ensdomains/ens-app-v3` | Frontend |
| `simplex-namespace-contract` (this repo) | — | Coordination: plan, docs, deployment helpers, test fixtures. Submodule parent. |

### Workspace layout

Both forks are git submodules of this repo so everything is accessible from a single working directory:

```
simplex-namespace-contract/           ← this repo (parent)
  ens-contracts/                      ← submodule → simplex-network/ens-contracts
  ens-app-v3/                         ← submodule → simplex-network/ens-app-v3
  snrc-implementation-plan.md
  CLAUDE.md
  scripts/                            ← cross-repo deployment helpers
  docs/                               ← project-level documentation
  test/                               ← cross-repo test fixtures (e2e orchestration)
```

### Branch hygiene

- `main` in each fork tracks upstream ENS (fetch-only, never commit directly)
- `simplex` branch in each fork is our working branch — all SNRC changes go here
- The diff `main...simplex` on GitHub is the audit surface
- Keep `simplex` rebased on `main` so the diff stays clean

---

## Executive Summary

Full fork of `ensdomains/ens-contracts`, adapted. Unchanged contracts keep their ENS filenames for easy diffing. **Two separate deployments** — one per TLD, each is essentially a standard ENS deployment with a custom controller.

- **Registry**: `ENSRegistry` (UUPS-wrapped, zero logic changes) — one per TLD deployment
- **Resolver**: ENS `PublicResolver` — **verbatim**. SimpleX links stored as text records (`simplex.contact`, `simplex.channel`)
- **Registrar**: `BaseRegistrarImplementation` (UUPS-wrapped, zero logic changes) — one per TLD
- **Controller**: `SimplexController` — **new**, fork of ETHRegistrarController adding length gate + reserved names. NFT gate only on `.testing`. Smallest possible diff from ENS.
- **Price oracle**: ENS's `StablePriceOracle` + `ExponentialPremiumPriceOracle` — verbatim
- **NameWrapper**: ENS `NameWrapper` — **verbatim** (UUPS-wrapped). Each deployment has one TLD, so no multi-TLD parameterization needed.
- **Root + ReverseRegistrar**: verbatim ENS copies
- **Payment**: ETH (same as ENS)
- **NFT gate**: `.testing` only — checks `balanceOf(sender) > 0` on SMPXNFT (`0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`). `.simplex` has no NFT gate.
- **Frontend**: fork of `ensdomains/ens-app-v3`, minimal diff — logo swap + contract rewiring + hide images
- **Deployment targets**: Hardhat local, Hoodi testnet, Ethereum mainnet (both TLDs on mainnet)

---

## Architecture

### Two separate deployments (one per TLD)

`.testing` launches first. `.simplex` follows. Each is an independent ENS-like deployment:

```
.testing deployment (launched first):
  ENSRegistry → BaseRegistrarImplementation → SimplexController
                                               (NFT-gated, 6+ chars, reserved names)
  PublicResolver (verbatim ENS)
  NameWrapper (UUPS-wrapped, verbatim ENS)
  Root, ReverseRegistrar

.simplex deployment (launched later):
  ENSRegistry → BaseRegistrarImplementation → SimplexController
                                               (NO NFT gate, 6+ chars, reserved names)
  PublicResolver (verbatim ENS)
  NameWrapper (UUPS-wrapped, verbatim ENS)
  Root, ReverseRegistrar
```

Separate deployments mean each one is a near-standard ENS deployment. The NameWrapper doesn't need multi-TLD changes — it just handles one TLD per deployment, exactly like ENS handles `.eth`. This eliminates the `SNRCNameWrapper` rename entirely.

### Data flow: name registration

Same as ENS, with two additional checks inserted into the controller:

```
User → controller.commit(hash)
     → wait 60s
     → controller.register{value: price}(name, owner, duration, secret, resolver, data)
       ├─ _consumeCommitment()           // unchanged from ENS
       ├─ _isNameAllowed(name)           // NEW: length + reserved check
       ├─ _checkNftGate(sender)          // NEW: .testing only, if nftGateEnabled
       ├─ priceOracle.price(...)         // unchanged — ENS StablePriceOracle
       ├─ require(msg.value >= price)    // unchanged — ETH payment
       ├─ base.register(id, owner, duration)    // unchanged
       ├─ [resolver setup via ENS PublicResolver] // unchanged
       └─ refund excess ETH to sender    // unchanged
```

### SimpleX data in the resolver

No custom resolver. ENS's `PublicResolver.setText()` / `text()` is used with these keys:

- `simplex.contact` — SimpleX contact short link (1:1 messaging)
- `simplex.channel` — SimpleX channel short link (group/channel)

This is the standard ENS text-record pattern. Zero contract changes.

### Pricing (USD-denominated, paid in ETH via Chainlink oracle — same as ENS)

| Length | Annual USD price |
|--------|-----------------|
| 6+     | $1              |
| 5      | $8              |
| 4      | $32             |
| 3      | $128            |

Configured via ENS's `StablePriceOracle` constructor (array of USD prices per character length). Dutch auction for expired names via `ExponentialPremiumPriceOracle` — unchanged from ENS.

---

## ENS contract reuse map

Goal: minimal diff to upstream ENS contracts for easy auditing. Each contract falls into one of four categories.

### Verbatim (zero diff from ENS)

| ENS file | Our path | Notes |
|----------|----------|-------|
| `registry/ENS.sol` | `contracts/registry/ENS.sol` | Interface, unchanged |
| `ethregistrar/IBaseRegistrar.sol` | `contracts/ethregistrar/IBaseRegistrar.sol` | Interface, unchanged |
| `wrapper/ERC1155Fuse.sol` | `contracts/wrapper/ERC1155Fuse.sol` | ERC-1155 + fuse bit logic |
| `wrapper/Controllable.sol` | `contracts/wrapper/Controllable.sol` | Controller access pattern |
| `wrapper/StaticMetadataService.sol` | `contracts/wrapper/StaticMetadataService.sol` | Token URI service |
| `wrapper/BytesUtils.sol` | `contracts/wrapper/BytesUtils.sol` | Byte manipulation |
| `ethregistrar/StringUtils.sol` | `contracts/ethregistrar/StringUtils.sol` | UTF-8 strlen |
| `utils/ERC20Recoverable.sol` | `contracts/utils/ERC20Recoverable.sol` | ERC-20 recovery |
| `root/Root.sol` | `contracts/root/Root.sol` | Trivial, non-upgradeable |
| `reverseRegistrar/ReverseRegistrar.sol` | `contracts/reverseRegistrar/ReverseRegistrar.sol` | Unchanged |
| `ethregistrar/StablePriceOracle.sol` | `contracts/ethregistrar/StablePriceOracle.sol` | USD pricing, Chainlink oracle |
| `ethregistrar/ExponentialPremiumPriceOracle.sol` | `contracts/ethregistrar/ExponentialPremiumPriceOracle.sol` | Dutch auction for expired names |
| `ethregistrar/IPriceOracle.sol` | `contracts/ethregistrar/IPriceOracle.sol` | Price oracle interface |
| `ethregistrar/DummyOracle.sol` | `contracts/ethregistrar/DummyOracle.sol` | Test oracle (fixed ETH/USD rate) |
| `resolvers/PublicResolver.sol` + `profiles/*` | unchanged | All resolver profiles kept — SimpleX links stored as text records |
| `wrapper/NameWrapper.sol` | `contracts/wrapper/NameWrapper.sol` | Unchanged — each deployment handles one TLD (like `.eth`) |

### Mechanical UUPS wrapping only (constructor → initialize, + UUPSUpgradeable)

These contracts keep all ENS logic intact. The only diff is the upgrade boilerplate — a reviewer can verify in seconds:
1. `constructor(...)` → `function initialize(...) initializer`
2. Add `UUPSUpgradeable, OwnableUpgradeable` inheritance
3. Add `function _authorizeUpgrade(address) internal override onlyOwner {}`
4. Add `/// @custom:oz-upgrades-unsafe-allow constructor` + `_disableInitializers()`

File names kept identical to ENS for easy diffing.

| ENS file | Our path | Logic changes |
|----------|----------|--------------|
| `registry/ENSRegistry.sol` | `contracts/registry/ENSRegistry.sol` | None — UUPS wrap only |
| `ethregistrar/BaseRegistrarImplementation.sol` | `contracts/ethregistrar/BaseRegistrarImplementation.sol` | None — UUPS wrap only |

### New contracts (no ENS equivalent)

| Our path | Why new |
|----------|---------|
| `contracts/controller/SimplexController.sol` | Fork of `ETHRegistrarController` adding length gate, reserved names, and NFT gate (`.testing` only). Payment, commit-reveal, pricing — all unchanged from ENS. |
| `contracts/mocks/MockSMPXNFT.sol` | Test mock for SMPXNFT |

### Dropped from ENS (not forked)

| ENS module | Why dropped |
|------------|------------|
| `dnsregistrar/` + `dnssec-oracle/` | No DNS integration needed |

### Audit summary

An auditor needs to focus on:
1. **SimplexController.sol** — the only contract with new logic: length gate, reserved names, NFT gate. Everything else (payment, pricing, commit-reveal) is unchanged ENS. This is the entire attack surface.
2. **UUPS-wrapped contracts** — verify the upgrade boilerplate is correct (mechanical, ~10 lines each).

Everything else is verbatim ENS (audited by Trail of Bits, OpenZeppelin) or standard OpenZeppelin v5.

---

## Phases

### Phase 1: Submodules + scaffolding

**Goal**: Working workspace with both forks as submodules, ENS compiling and tests passing before any changes.

1. Add submodules to this repo:
   ```
   git submodule add -b simplex https://github.com/simplex-network/ens-contracts.git ens-contracts
   git submodule add -b simplex https://github.com/simplex-network/ens-app-v3.git ens-app-v3
   ```
2. In each fork, create `simplex` branch from the upstream default branch
3. In `ens-contracts/`: `pnpm install`, verify `npx hardhat compile` and existing ENS tests pass unmodified
4. Add `@openzeppelin/contracts-upgradeable` v5 + `@openzeppelin/hardhat-upgrades` to `ens-contracts` dependencies (needed for UUPS)
5. Add Hoodi network config (chainId 560048) to `ens-contracts/hardhat.config.ts`
6. Create `scripts/`, `docs/`, `test/` dirs in this parent repo for cross-repo helpers

**Verify**: `cd ens-contracts && npx hardhat compile` passes. Existing ENS test suite passes on `simplex` branch before any SNRC changes.

### Phase 2: Mock contracts

**Goal**: Testable mock for SMPXNFT.

**`contracts/mocks/MockSMPXNFT.sol`** — faithful mock of `0x3AF6D9Ee...`:
- ERC-721 (OZ v5) with Enumerable
- Constructor: `"SimpleX NFT: SMPX testnet access"`, `"SMPXNFT"`
- `mint(address to)` — sequential IDs via `nextTokenId` counter, only `minter` or `owner`
- `setMinter(address)` — owner only
- `setNextTokenURI(string)` — owner only
- `lockMintingPermanently()` — irreversible, owner only
- `burn(uint256 tokenId)` — token owner only
- `withdraw()` — owner only

ENS's `DummyOracle.sol` (fixed ETH/USD rate) is used for local testing — no custom mock needed.

**Verify**: MockSMPXNFT compiles, unit tests for mint/transfer/balanceOf pass.

### Phase 3: Core registry (ENS fork)

**Goal**: `ENSRegistry` with UUPS upgradeability.

Mechanical UUPS wrap of `ENSRegistry.sol` — see reuse map. Zero logic changes, file keeps its ENS name. The `ENS.sol` interface is copied verbatim.

Namehash scheme is identical to ENS: `namehash("alice.simplex") = keccak256(namehash("simplex"), keccak256("alice"))`.

**Verify**: Deploy behind ERC1967 proxy. `setSubnodeOwner`, `setRecord`, `owner()`, `resolver()` work in unit tests.

### Phase 4: Resolver (ENS PublicResolver, verbatim)

**Goal**: Deploy ENS's PublicResolver unchanged. SimpleX links stored as text records.

No custom resolver needed. Use `PublicResolver.setText(node, key, value)` with:
- Key `"simplex.contact"` — contact short link
- Key `"simplex.channel"` — channel short link

PublicResolver already supports arbitrary text records, authorization checks, and batch operations via Multicallable. Zero code changes.

**Verify**: `setText` / `text` work for `simplex.contact` and `simplex.channel` keys. Standard ENS behavior.

### Phase 5: Base registrar (ERC-721 per TLD)

**Goal**: `BaseRegistrarImplementation` with UUPS.

Mechanical UUPS wrap of `BaseRegistrarImplementation.sol` — see reuse map. Zero logic changes, file keeps its ENS name. All ENS ERC-721 mechanics (tokenId = labelhash, expiry tracking, grace period, controller authorization) preserved verbatim.

One instance per TLD deployment — each initialized with its own `baseNode` (e.g., `namehash("testing")` or `namehash("simplex")`). Same contract, different deployments.

**Verify**: Register name, check expiry, renew, verify ERC-721 ownership, reclaim registry record.

### Phase 6: Controller (commit-reveal + pricing + gates)

Fork of `ETHRegistrarController`. Payment, pricing, commit-reveal, and refund logic are identical to ENS. The only additions are two access-control checks (+ NFT gate for `.testing` only) and admin functions.

**Price oracle**: ENS's `StablePriceOracle` + `ExponentialPremiumPriceOracle` used verbatim. Configure with USD prices: $1 (6+ chars), $8 (5), $32 (4), $128 (3). For local dev, use ENS's `DummyOracle` (fixed ETH/USD rate).

**`contracts/controller/SimplexController.sol`** — diff from `ETHRegistrarController`:

Added state:
- `uint8 public minCharLength` (starts at 6 in both deployments)
- `mapping(bytes32 => bool) public reservedNames`
- `IERC721 public smpxNft` (`.testing` deployment only; `address(0)` for `.simplex`)
- `bool public nftGateEnabled` (`.testing` = true; `.simplex` = false, never changes)

Added checks in `register()` (inserted before existing ENS logic):
1. `require(strlen(name) >= minCharLength)`
2. `require(!reservedNames[keccak256(bytes(name))])`
3. `if (nftGateEnabled) require(smpxNft.balanceOf(msg.sender) > 0)` ← .testing only

Everything else unchanged: commit-reveal, `msg.value` ETH payment, price oracle call, refund excess, resolver setup.

For `.simplex` deployment: `nftGateEnabled = false` and `smpxNft = address(0)`. The NFT gate code path is dead — effectively this deployment's diff from `ETHRegistrarController` is just length + reserved-name checks.

Added admin functions:
- `setNftGateEnabled(false)` — one-way (true→false only), for .testing to eventually open up
- `setMinCharLength(uint8 newMin)` — must be < current (monotonic decrease: 6→5→4→3)
- `addReservedName(string)` / `removeReservedName(string)`
- `registerReserved(string name, address owner, uint256 duration)` — admin registers bypassing gates

**Verify**: Full commit-reveal flow (ETH payment); NFT gate blocks non-holders (.testing); reserved names enforced; length gate enforced with monotonic decrease; .simplex controller works without NFT gate.

### Phase 7: NameWrapper (ERC-1155)

**Goal**: Deploy ENS NameWrapper with UUPS wrapping only.

Each deployment handles one TLD, so NameWrapper works exactly like ENS's `.eth` setup — no multi-TLD parameterization needed. Mechanical UUPS wrap only (same pattern as registry and registrar).

Supporting files verbatim: `ERC1155Fuse.sol`, `Controllable.sol`, `BytesUtils.sol`, `StaticMetadataService.sol`.

**Verify**: Wrap name, verify ERC-1155 token, burn fuses, verify restrictions, unwrap. Standard ENS behavior.

### Phase 8: Reverse registrar + Root

Both are verbatim copies — see reuse map. Files keep their ENS names.

**ReverseRegistrar**: copied unchanged.
**Root**: copied unchanged (non-upgradeable, trivially simple).

**Verify**: Root assigns TLD ownership. Locked TLDs cannot be reassigned.

### Phase 9: Deployment scripts

Each TLD is an independent deployment. Same script, parameterized by TLD.

**`scripts/deploy.ts`** — deploys one TLD (parameterized):
1. Deploy ENSRegistry (UUPS proxy)
2. Deploy PublicResolver (verbatim ENS)
3. Deploy ReverseRegistrar
4. Deploy Root (non-proxy), transfer registry root to Root
5. Deploy BaseRegistrarImplementation (UUPS proxy, `baseNode = namehash(tld)`)
6. Root: set subnode owner for TLD, lock
7. Deploy price oracle (DummyOracle for local/testnet, Chainlink for mainnet) + ExponentialPremiumPriceOracle
8. Deploy SimplexController (configured per TLD — see below)
9. Add controller to base registrar
10. Deploy NameWrapper (UUPS-wrapped, verbatim ENS)
11. Output all addresses to `deployments/<network>-<tld>.json`

**Per-TLD config**:
- `.testing`: `nftGateEnabled=true`, `smpxNft=MockSMPXNFT` (local) / `0x3AF6D9Ee...` (mainnet), `minChars=6`
- `.simplex`: `nftGateEnabled=false`, `smpxNft=address(0)`, `minChars=6`

**`scripts/deploy-helpers.ts`** — namehash/labelhash computation, address logging, JSON persistence.

For local dev, both TLDs deployed to same Hardhat node. MockSMPXNFT deployed once, shared.

**Verify**: `npx hardhat run scripts/deploy.ts --tld testing` succeeds. Register a name, set text records, read back.

### Phase 10: Test suite

**Unit tests** (`test/unit/*.test.ts`) — one file per contract. Key scenarios for SimplexController:
- Commit-reveal: happy path, too-early revert, too-late revert
- NFT gate (.testing): non-holder reverts, holder succeeds, disable gate → anyone succeeds
- Reserved names: user blocked, admin registers to address, admin releases
- Min char length: enforced, admin lowers monotonically, cannot raise
- Pricing: correct ETH amounts for 3/4/5/6+ chars (via ENS price oracle)
- ETH payment: insufficient msg.value reverts, excess refunded
- Renewal + Dutch auction premium (ENS logic, just verify it works with our controller)
- UUPS: admin can upgrade, non-admin cannot

**Integration test** (`test/integration/full-flow.test.ts`):
- Deploy .testing TLD, exercise full lifecycle: register with NFT gate, set/read text records (`simplex.contact`, `simplex.channel`), transfer, renew, expire, re-register with auction, wrap in NameWrapper, admin operations
- Deploy .simplex TLD (no NFT gate), verify registration works without NFT

**Verify**: `npx hardhat test` all green. >90% line coverage on core contracts.

### Phase 11: Frontend dApp (Fork of ens-app-v3)

Fork [ensdomains/ens-app-v3](https://github.com/ensdomains/ens-app-v3) and adapt with surgical changes. The ENS app is production-grade with commit-reveal registration flow, name management, wallet connection, and transaction state handling already built. We restyle and rewire rather than rebuild.

**ENS app stack** (kept as-is):
- Next.js (Pages Router), React 18, TypeScript
- styled-components + `@ensdomains/thorin` design system
- wagmi + viem (wallet/chain interaction)
- TanStack Query (data fetching)
- `@ensdomains/ensjs` (ENS contract interaction library)
- Transaction-flow state machine (`src/transaction-flow/`)
- Playwright e2e test suite (we adapt rather than rewrite)
- pnpm package manager

**Approach: minimal diff.** The ENS app has ~100+ components and a polished UX. Keep ENS styling, layout, and Thorin design system entirely. Only change what is functionally different.

#### A. Branding (logo only)

Replace logo and favicon in `public/` and `src/assets/` with SimpleX equivalents. No theme overrides, no font changes, no color changes.

#### B. Contract rewiring

Replace ENS contract addresses and ABIs with SNRC equivalents:

- **ensjs replacement**: The ENS app uses `@ensdomains/ensjs` for all contract calls. Two options:
  1. **Fork ensjs** and adapt (heavy but clean)
  2. **Replace call sites** with direct viem contract reads/writes using SNRC ABIs (lighter, surgical)
  - Recommend option 2: create `src/contracts/snrc.ts` with typed contract instances, then replace ensjs calls in hooks and transaction-flow

- **Key files to rewire**:
  - `src/constants/` — chain configs, contract addresses → point to SNRC deployment addresses
  - `src/hooks/` — hooks that call ensjs functions → replace with direct viem calls to SNRC contracts
  - `src/transaction-flow/transaction/` — each tx type (registerName, renewNames, etc.) → adapt to SimplexController ABI
  - `src/transaction-flow/input/` — registration input flow → add TLD selector (.simplex/.testing), NFT gate check

- **Contract address config**: load from `deployments/<network>.json` (output by deploy scripts). Wire into wagmi config per chain.

#### C. Features to disable/hide

Disable at the route/component level (short-circuit, don't delete ENS code):

- **DNS import** (`src/pages/import.tsx`) — not applicable
- **ENS v2 migration** (`src/pages/ens-v2.tsx`) — not applicable
- **Legacy favourites** (`src/pages/legacyfavourites.tsx`) — not applicable
- **Reverse resolution UI** — keep the contract but hide UI for now
- **Avatar / image upload** — remove image upload capability, don't display images even if present in records. Leave contracts unchanged.
- **Subname management UI** — subnames are off-chain per whitepaper, disable on-chain subname creation UI

#### D. Features to add/adapt

- **TLD config**: Each frontend deployment targets one TLD. The ENS app hardcodes `.eth` — change to `.testing` or `.simplex` via config. No TLD selector needed (separate deployments).
- **NFT gate indicator** (`.testing` only): Check `smpxNft.balanceOf(sender)` and show status. Block registration with clear message if gate active and user has no NFT.
- **SimpleX link fields**: In the name profile/management view, show `simplex.contact` and `simplex.channel` text record fields prominently. Other text records can stay visible but are secondary.
- **Pricing display**: Show SNRC pricing ($1/$8/$32/$128 USD, paid in ETH) instead of ENS pricing.
- **Admin panel**: New page (`src/pages/admin.tsx`) for admin functions: manage reserved names, adjust min char length, toggle NFT gate. Only visible when connected wallet is admin.

#### E. Test account support for local dev

The ENS app already supports local dev via `pnpm dev:glocal` (Hardhat + Anvil). Adapt this:
- Configure local Hardhat node as a chain option in wagmi config
- Use Hardhat's default test accounts (the "test test test..." mnemonic the ENS app already documents)
- Add Hoodi testnet as a chain option

#### F. File structure (what changes vs. stays)

```
frontend/                          (clone of ens-app-v3)
  src/
    contracts/
      snrc.ts                      NEW — SNRC contract ABIs + typed instances
      addresses.ts                 NEW — load from deployments/<network>.json
    constants/
      chains.ts                    MODIFIED — add Hardhat local, Hoodi
      contracts.ts                 MODIFIED — replace ENS addresses with SNRC
    hooks/
      useNameAvailability.ts       MODIFIED — call BaseRegistrarImplementation.available()
      useRegistration.ts           MODIFIED — call SimplexController
      useNftGate.ts                NEW — check SMPXNFT balance
      usePricing.ts                MODIFIED — configure SNRC price tiers (ENS oracle, different USD amounts)
    transaction-flow/
      transaction/
        registerName.ts            MODIFIED — SimplexController.register (ETH payment unchanged)
        renewNames.ts              MODIFIED — SimplexController.renew (ETH payment unchanged)
      input/
        [registration inputs]      MODIFIED — NFT gate check (.testing deploy only)
    components/
      pages/profile/               MODIFIED — hide images, highlight simplex.contact/channel fields
    pages/
      index.tsx                    MODIFIED — TLD name in search (config, not selector)
      register.tsx                 MODIFIED — NFT gate check (.testing deploy only)
      admin.tsx                    NEW — admin panel
      import.tsx                   DISABLED
      ens-v2.tsx                   DISABLED
      legacyfavourites.tsx         DISABLED
    assets/                        MODIFIED — SimpleX logo only
  public/                          MODIFIED — SimpleX favicon only
  next.config.mjs                  MODIFIED — remove ENS-specific rewrites if any
```

**Verify**: `pnpm dev` opens at localhost:3000. Connect MetaMask to local Hardhat node. Search for name, see availability with correct pricing, complete registration flow (commit → wait → register, pay ETH), see name in "My Names" with contact/channel link fields.

### Phase 12: Playwright e2e

Adapt the existing ENS app Playwright suite (`e2e/specs/`) rather than writing from scratch. The ENS app already has stateless and stateful e2e test infrastructure with Hardhat/Anvil backends.

- **Keep**: ENS app's Playwright config, fixtures, wallet injection pattern (test mnemonic)
- **Adapt existing specs**: rewire registration, renewal, profile specs to use SNRC contracts
- **Add new specs**:
  - `nft-gate.spec.ts`: .testing blocked without NFT, mint NFT, retry → succeeds
  - `simplex-links.spec.ts`: set + read `simplex.contact` and `simplex.channel` text records
  - `admin.spec.ts`: lower char length, reserve/release names
- **Remove/skip**: DNS import specs, ENS v2 migration specs, legacy favourites specs

**Verify**: `pnpm e2e` passes adapted + new specs.

### Phase 13: Documentation

- Update `CLAUDE.md` with build commands, architecture summary, gotchas
- `README.md` with setup, deployment guide, architecture overview
- `docs/architecture.md`, `docs/deployment.md`, `docs/testing.md`

---

## Verification

End-to-end verification after all phases:

1. `npx hardhat compile` — all contracts compile without warnings
2. `npx hardhat test` — all unit + integration tests pass, >90% coverage
3. `npx hardhat run scripts/deploy-local.ts` — full deployment succeeds
4. Frontend `pnpm dev` — search + register + set links works in browser against local Hardhat node
5. `pnpm e2e` — adapted + new Playwright specs pass
6. Manual demo: register `testname.testing` with NFT gate, register `testname.simplex` without, set `simplex.contact` text record, read back, renew, transfer ownership

---

## Phase dependency graph

```
Phase 1 (Scaffolding)
  │
Phase 2 (Mocks)
  │
  ├── Phase 3 (Registry) ──┐
  ├── Phase 4 (Resolver)    ├── Phase 6 (Controller) ── most complex
  └── Phase 5 (Registrar) ─┘        │
                                     ├── Phase 7 (NameWrapper)
                                     └── Phase 8 (Reverse + Root)
                                              │
                                     Phase 9 (Deploy Scripts)
                                              │
                                     Phase 10 (Tests)
                                              │
                                     Phase 11 (Frontend)
                                              │
                                     Phase 12 (E2E)
                                              │
                                     Phase 13 (Docs)
```

Phases 3, 4, 5 can proceed in parallel after Phase 2.
