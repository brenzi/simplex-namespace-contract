# SNRC Implementation Plan: SimpleX Namespace Registry Contract

## Table of Contents

1. [Context](#context)
2. [Executive Summary](#executive-summary)
3. [Architecture](#architecture)
4. [Phases](#phases)
   - Phase 1: Scaffolding
   - Phase 2: Mock contracts
   - Phase 3: Core registry (ENS fork)
   - Phase 4: Simplified resolver (categorized links)
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

SimpleX Chat needs a decentralized namespace registry (SNRC) mapping human-readable names (`alice.simplex`) to SimpleX short link data on Ethereum. The whitepaper (§Public Namespaces) specifies ENS as the model. This project forks the full ENS contract suite and adapts it for SimpleX's requirements: two TLDs, NFT-gated registration, reserved names, length restrictions, stablecoin payments, and UUPS upgradeability.

Existing assets to reuse:
- `TestUSDC.sol` from `/work/simplex-community-credits-poc/contracts/contracts/TestUSDC.sol`
- Solidity 0.8.24 + Hardhat toolchain already installed on this machine
- Whitepaper at `/work/community-credits-whitepaper/`

---

## Executive Summary

Full fork of `ensdomains/ens-contracts`, adapted. Unchanged contracts keep their ENS filenames for easy diffing.
- **Registry**: `ENSRegistry` (UUPS-wrapped, zero logic changes)
- **Resolver**: `SimplexResolver` — **new**, categorized link storage per name (contact link, channel link, extensible via `bytes32` keys)
- **Registrar**: `BaseRegistrarImplementation` (UUPS-wrapped, zero logic changes) — two instances, one for `.simplex`, one for `.testing`
- **Controller**: `SimplexController` — **new**, fork of ETHRegistrarController with stablecoin pricing, NFT gate, reserved names, min-length gate. Two instances with different configs per TLD
- **NameWrapper**: `SNRCNameWrapper` (renamed — moderate changes: parameterized TLD support instead of hardcoded `.eth`)
- **Root + ReverseRegistrar**: verbatim ENS copies
- **Payment**: ERC-20 stablecoin (USDC/USDT), not ETH
- **NFT gate**: checks `balanceOf(sender) > 0` on the SMPXNFT contract (`0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`, ERC-721, 560 tokens, name "SimpleX NFT: SMPX testnet access", symbol "SMPXNFT")
- **Frontend**: fork of `ensdomains/ens-app-v3` (Next.js + styled-components + wagmi/viem), minimal diff — logo swap + contract rewiring only
- **Deployment targets**: Hardhat local, Hoodi testnet, Ethereum mainnet

---

## Architecture

### Single registry, dual registrar/controller pairs

```
ENSRegistry (one instance, UUPS proxy)
  ├─ .simplex node → BaseRegistrarImplementation#1 → SimplexController#1
  │                   (NFT-gated, 6+ chars, reserved names, stablecoin pricing)
  ├─ .testing node → BaseRegistrarImplementation#2 → SimplexController#2
  │                   (open, 3+ chars, free or nominal fee)
  ├─ .addr.reverse → ReverseRegistrar
  └─ Root (assigns TLD ownership, lockable)

SimplexResolver (one instance, UUPS proxy)               ← new contract
  mapping(bytes32 node => mapping(bytes32 category => bytes data))
  categories: keccak256("contact"), keccak256("channel"), ... extensible

SNRCNameWrapper (one instance, UUPS proxy)                ← renamed (moderate changes)
  wraps names from both TLDs as ERC-1155 tokens with fuses
```

### Data flow: name registration

```
User → approve(USDC, controller, amount)
     → controller.commit(hash)
     → wait 60s
     → controller.register(name, owner, duration, secret, resolver, data)
       ├─ _consumeCommitment()
       ├─ _isNameAllowed(name)  // length + reserved check
       ├─ _checkNftGate(sender) // if nftGateEnabled
       ├─ priceOracle.price(name, 0, duration)
       ├─ USDC.transferFrom(sender, treasury, price)
       ├─ base.register(id, owner, duration)  // mints ERC-721
       └─ resolver.setLink(node, category, data)  // optional, if data provided
```

### Whitepaper pricing (denominated in stablecoin)

| Length | Multiplier | Example (base=1 USDC) |
|--------|------------|----------------------|
| 6+     | 1x         | 1 USDC/year          |
| 5      | 8x         | 8 USDC/year          |
| 4      | 32x        | 32 USDC/year         |
| 3      | 128x       | 128 USDC/year        |

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

### Moderate changes (ENS logic preserved, SNRC-specific adaptations)

Renamed because the interface/behavior changes enough that keeping the ENS name would be misleading.

| ENS file | Our path | What changes |
|----------|----------|-------------|
| `wrapper/NameWrapper.sol` | `contracts/wrapper/SNRCNameWrapper.sol` | UUPS wrap + replace hardcoded `.eth` node with parameterized TLD nodes, rename `wrapETH2LD` → `wrapSNRC2LD`, support two base registrars instead of one. Fuse system, expiry logic, ERC-1155 mechanics — all unchanged. |

### New contracts (no ENS equivalent)

| Our path | Why new |
|----------|---------|
| `contracts/resolver/SimplexResolver.sol` | ENS PublicResolver has ~8 profile contracts (AddrResolver, TextResolver, ContentHashResolver...). We replace all of them with a single categorized-link mapping. Clean-room, ~50 lines of logic. |
| `contracts/controller/SimplexController.sol` | Fork of `ETHRegistrarController` but heavily adapted: stablecoin payment (not ETH), NFT gate, reserved names, min-length gate, admin functions. Commit-reveal core kept from ENS. |
| `contracts/controller/SimplexPriceOracle.sol` | Replaces ENS's `StablePriceOracle` + `ExponentialPremiumPriceOracle`. No Chainlink feed (prices are in stablecoin directly). Dutch auction decay logic reused from ENS. |
| `contracts/interfaces/ISimplexResolver.sol` | New interface for categorized links |
| `contracts/interfaces/ISimplexController.sol` | New interface for controller |
| `contracts/mocks/MockSMPXNFT.sol` | Test mock |
| `contracts/mocks/TestUSDC.sol` | Test mock (from PoC) |

### Dropped from ENS (not forked)

| ENS module | Why dropped |
|------------|------------|
| `dnsregistrar/` + `dnssec-oracle/` | No DNS integration needed |
| `resolvers/PublicResolver.sol` + `profiles/*` | Replaced by SimplexResolver |
| `ethregistrar/StablePriceOracle.sol` | Replaced by SimplexPriceOracle |
| `ethregistrar/ExponentialPremiumPriceOracle.sol` | Dutch auction logic extracted into SimplexPriceOracle |
| `ethregistrar/DummyOracle.sol`, `TestResolver.sol` | ENS test helpers, not needed |

### Audit summary

An auditor reviewing SNRC needs to focus on:
1. **SimplexController.sol** — all SNRC-specific access control (NFT gate, reserved names, length gate, stablecoin payment). This is the primary attack surface.
2. **SimplexPriceOracle.sol** — pricing logic correctness.
3. **SimplexResolver.sol** — authorization for link writes.
4. **UUPS-wrapped contracts** — verify the upgrade pattern is correctly applied (mechanical check).
5. **SNRCNameWrapper.sol** — verify `.eth` → TLD parameterization didn't break fuse logic.
6. **ENSRegistry.sol / BaseRegistrarImplementation.sol** — verify UUPS boilerplate is correct (mechanical, ~10 lines each).

Everything else is verbatim ENS (audited by Trail of Bits, OpenZeppelin) or standard OpenZeppelin v5.

---

## Phases

### Phase 1: Scaffolding

**Goal**: Compiling, empty-test-passing Hardhat project.

- `package.json`: Hardhat 2.x, `@nomicfoundation/hardhat-toolbox`, `@openzeppelin/contracts` v5, `@openzeppelin/contracts-upgradeable` v5, `@openzeppelin/hardhat-upgrades`, `dotenv`, ethers v6. Match PoC convention: Solidity 0.8.24, optimizer 200 runs, evmVersion paris.
- `hardhat.config.ts`: networks for hardhat, hoodi (chainId 560048), mainnet (chainId 1). Named accounts: deployer, admin, treasury.
- Directory tree: `contracts/{registry,registrar,controller,resolver,wrapper,root,mocks,utils,interfaces}/`, `scripts/`, `test/{unit,integration}/`, `frontend/`, `e2e/`
- `.env.example`, `.gitignore`, `tsconfig.json`

**Verify**: `npx hardhat compile` exits 0.

### Phase 2: Mock contracts

**Goal**: Testable mocks for SMPXNFT and stablecoin.

**`contracts/mocks/MockSMPXNFT.sol`** — faithful mock of `0x3AF6D9Ee...`:
- ERC-721 (OZ v5) with Enumerable
- Constructor: `"SimpleX NFT: SMPX testnet access"`, `"SMPXNFT"`
- `mint(address to)` — sequential IDs via `nextTokenId` counter, only `minter` or `owner`
- `setMinter(address)` — owner only
- `setNextTokenURI(string)` — owner only
- `lockMintingPermanently()` — irreversible, owner only
- `burn(uint256 tokenId)` — token owner only
- `withdraw()` — owner only

**`contracts/mocks/TestUSDC.sol`** — copy from PoC (`/work/simplex-community-credits-poc/contracts/contracts/TestUSDC.sol`), proven working.

**Verify**: Both compile, unit tests for mint/transfer/balanceOf pass.

### Phase 3: Core registry (ENS fork)

**Goal**: `ENSRegistry` with UUPS upgradeability.

Mechanical UUPS wrap of `ENSRegistry.sol` — see reuse map. Zero logic changes, file keeps its ENS name. The `ENS.sol` interface is copied verbatim.

Namehash scheme is identical to ENS: `namehash("alice.simplex") = keccak256(namehash("simplex"), keccak256("alice"))`.

**Verify**: Deploy behind ERC1967 proxy. `setSubnodeOwner`, `setRecord`, `owner()`, `resolver()` work in unit tests.

### Phase 4: Simplified resolver (categorized links)

**Goal**: Replace ENS multi-profile PublicResolver with purpose-built categorized link storage.

Each name can have multiple link categories. Initial categories:
- `contact` — SimpleX contact short link (1:1 messaging)
- `channel` — SimpleX channel short link (group/channel)
- More categories can be added later without contract changes (categories are arbitrary `bytes32` keys)

**`contracts/interfaces/ISimplexResolver.sol`**:
```solidity
interface ISimplexResolver {
    event LinkChanged(bytes32 indexed node, bytes32 indexed category, bytes data);
    function setLink(bytes32 node, bytes32 category, bytes calldata data) external;
    function getLink(bytes32 node, bytes32 category) external view returns (bytes memory);
    function getLinks(bytes32 node, bytes32[] calldata categories) external view returns (bytes[] memory);
}
```

Category constants (convenience, not enforced — any `bytes32` key works):
- `keccak256("contact")` = contact link
- `keccak256("channel")` = channel link

**`contracts/resolver/SimplexResolver.sol`**:
- UUPS + OwnableUpgradeable
- `mapping(bytes32 node => mapping(bytes32 category => bytes data)) private _links`
- Auth: caller must be node owner or approved operator in registry
- `setLink(node, category, data)` — set one category
- `getLink(node, category)` — read one category
- `getLinks(node, categories[])` — batch read multiple categories in one call
- This replaces ENS's ~8 profile contracts with one categorized mapping

**Verify**: Set contact + channel links for a name, read them back individually and in batch, unauthorized write reverts, empty category returns empty bytes.

### Phase 5: Base registrar (ERC-721 per TLD)

**Goal**: `BaseRegistrarImplementation` with UUPS.

Mechanical UUPS wrap of `BaseRegistrarImplementation.sol` — see reuse map. Zero logic changes, file keeps its ENS name. All ENS ERC-721 mechanics (tokenId = labelhash, expiry tracking, grace period, controller authorization) preserved verbatim.

Two instances deployed: one with `baseNode = namehash("simplex")`, one with `baseNode = namehash("testing")`.

**Verify**: Register name, check expiry, renew, verify ERC-721 ownership, reclaim registry record.

### Phase 6: Controller (commit-reveal + pricing + gates)

This is the core SNRC-specific contract — most divergence from ENS lives here.

**`contracts/controller/SimplexPriceOracle.sol`**:
- No Chainlink feed needed — prices are in stablecoin directly
- `uint256 public baseRate` (admin-settable, default 1_000_000 = 1 USDC at 6 decimals)
- `price(string name, uint256 expires, uint256 duration) → (base, premium)`
- Length multipliers: 6+ → 1x, 5 → 8x, 4 → 32x, 3 → 128x
- Dutch auction premium for expired names: starts at configurable `startPremium`, halves daily for 28 days (fork ENS `ExponentialPremiumPriceOracle` logic)

**`contracts/controller/SimplexController.sol`**:

State:
- `IERC20 public paymentToken` (USDC/USDT)
- `address public treasury`
- `IERC721 public smpxNft`
- `bool public nftGateEnabled` (starts true for .simplex, false for .testing)
- `uint8 public minCharLength` (starts 6 for .simplex, 3 for .testing)
- `mapping(bytes32 => bool) public reservedNames`
- Pointers to `priceOracle` and `base` (base registrar)

Commit-reveal (keep from ENS):
- `makeCommitment()` → pure hash
- `commit(bytes32)` → store with timestamp
- `_consumeCommitment()` → validate 60s–24h window

Registration:
1. Consume commitment
2. Check `strlen(name) >= minCharLength`
3. Check `!reservedNames[keccak256(bytes(name))]`
4. If `nftGateEnabled`: check `smpxNft.balanceOf(msg.sender) > 0`
5. Calculate price via oracle
6. `paymentToken.transferFrom(msg.sender, treasury, totalPrice)`
7. `base.register(tokenId, owner, duration)`
8. Optionally set resolver + data

Admin functions:
- `setNftGateEnabled(false)` — one-way (true→false only)
- `setMinCharLength(uint8 newMin)` — must be < current (monotonic decrease: 6→5→4→3)
- `addReservedName(string)` / `removeReservedName(string)`
- `registerReserved(string name, address owner, uint256 duration)` — bypasses gate + pricing
- `setTreasury(address)`, `setPaymentToken(address)`

Extension point for future voucher tokens:
- Internal `_checkVoucher()` hook — no-op now, can be overridden when ERC-1155 vouchers are added

**Verify**: Full commit-reveal flow; NFT gate blocks/allows correctly; reserved names enforced; length gate enforced with monotonic decrease; stablecoin payment correct; Dutch auction premium on expired names.

### Phase 7: NameWrapper (ERC-1155)

**Goal**: Fork ENS NameWrapper for ERC-1155 name wrapping with fuses.

Moderate changes — see reuse map. The NameWrapper gets UUPS wrapping plus `.eth`-specific references replaced with parameterized TLD support (two base registrar addresses instead of one, `wrapETH2LD` → `wrapSNRC2LD`). All fuse logic, expiry normalization, and ERC-1155 mechanics stay untouched.

Supporting files copied verbatim: `ERC1155Fuse.sol`, `Controllable.sol`, `BytesUtils.sol`, `StaticMetadataService.sol`.

**Verify**: Wrap name, verify ERC-1155 token, burn fuses, verify restrictions, unwrap.

### Phase 8: Reverse registrar + Root

Both are verbatim copies — see reuse map. Files keep their ENS names.

**ReverseRegistrar**: copied unchanged.
**Root**: copied unchanged (non-upgradeable, trivially simple).

**Verify**: Root assigns TLD ownership. Locked TLDs cannot be reassigned.

### Phase 9: Deployment scripts

**`scripts/deploy-local.ts`** — deployment order (critical dependency chain):
1. Deploy mocks: TestUSDC, MockSMPXNFT
2. Mint test NFTs + USDC to Hardhat accounts
3. Deploy ENSRegistry (UUPS proxy)
4. Deploy SimplexResolver (UUPS proxy)
5. Deploy ReverseRegistrar
6. Deploy Root (non-proxy), transfer registry root to Root
7. Deploy BaseRegistrarImplementation for `.simplex` (UUPS proxy, `baseNode = namehash("simplex")`)
8. Deploy BaseRegistrarImplementation for `.testing` (UUPS proxy, `baseNode = namehash("testing")`)
9. Root: set subnode owners for both TLDs, lock both
10. Deploy SimplexPriceOracle (baseRate = 1 USDC/year)
11. Deploy SimplexController for `.simplex` (nftGate=true, minChars=6)
12. Deploy SimplexController for `.testing` (nftGate=false, minChars=3)
13. Add controllers to their respective base registrars
14. Deploy SNRCNameWrapper (UUPS proxy)
15. Output all addresses to `deployments/<network>.json`

**`scripts/deploy-hoodi.ts`** — same order, uses `.env` keys, deploys mocks for NFT+USDC (no real ones on Hoodi), verifies on explorer.

**`scripts/deploy-mainnet.ts`** — uses real USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`), real SMPXNFT (`0x3AF6D9Ee...`), treasury = SNCC multisig.

**`scripts/deploy-helpers.ts`** — namehash/labelhash computation, address logging, JSON persistence.

**Verify**: `npx hardhat run scripts/deploy-local.ts` succeeds. Smoke test: register a name, read blob back.

### Phase 10: Test suite

**Unit tests** (`test/unit/*.test.ts`) — one file per contract. Key scenarios for SimplexController:
- Commit-reveal: happy path, too-early revert, too-late revert
- NFT gate: non-holder reverts (.simplex), holder succeeds, anyone succeeds (.testing), disable gate
- Reserved names: user blocked, admin registers to address, admin releases
- Min char length: enforced, admin lowers monotonically, cannot raise
- Pricing: correct for 3/4/5/6+ chars
- Stablecoin: insufficient allowance reverts, correct transfer to treasury
- Renewal + Dutch auction premium
- UUPS: admin can upgrade, non-admin cannot

**Integration test** (`test/integration/full-flow.test.ts`):
- Deploy entire system, exercise full lifecycle: register both TLDs, set/read blob data, transfer, renew, expire, re-register with auction, wrap in NameWrapper, admin operations

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
  - `src/transaction-flow/input/` — registration input flow → add TLD selector (.simplex/.testing), NFT gate check, USDC approval step

- **Contract address config**: load from `deployments/<network>.json` (output by deploy scripts). Wire into wagmi config per chain.

#### C. Features to disable/remove

Remove ENS-specific features that don't apply to SNRC. Disable at the route/component level (comment out or skip rendering), don't delete files:

- **DNS import** (`src/pages/import.tsx`) — not applicable
- **ENS v2 migration** (`src/pages/ens-v2.tsx`) — not applicable
- **Legacy favourites** (`src/pages/legacyfavourites.tsx`) — not applicable
- **Reverse resolution UI** — keep the contract but hide UI for now
- **Content hash / avatar / text records** in profile — replace with contact link + channel link fields
- **Subname management UI** — subnames are off-chain per whitepaper, disable on-chain subname creation UI
- **ETH payment flow** — replace with USDC approval + transferFrom flow
- **Price oracle integration** — replace Chainlink USD/ETH oracle calls with direct stablecoin price reads from SimplexPriceOracle

#### D. Features to add/adapt

- **TLD selector**: Add `.simplex` / `.testing` toggle to the search bar and registration flow. The ENS app hardcodes `.eth` — parameterize this.
- **NFT gate indicator**: On `.simplex` registration, check `smpxNft.balanceOf(sender)` and show status (gated/ungated, holder/non-holder). Block registration with clear message if gate active and user has no NFT.
- **USDC approval step**: Before commit, check `paymentToken.allowance(sender, controller)`. If insufficient, prompt approve tx first. Show USDC balance.
- **Categorized link editor**: Replace ENS's text-record/content-hash editor with contact link + channel link fields in the name management view.
- **Pricing display**: Show SNRC pricing table (1/8/32/128 USDC) instead of ENS pricing.
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
      usePricing.ts                MODIFIED — call SimplexPriceOracle
    transaction-flow/
      transaction/
        registerName.ts            MODIFIED — USDC approve + SimplexController.register
        renewNames.ts              MODIFIED — USDC + SimplexController.renew
      input/
        [registration inputs]      MODIFIED — add TLD selector, NFT gate, USDC approval
    components/
      pages/profile/               MODIFIED — contact/channel link fields instead of text records
    pages/
      index.tsx                    MODIFIED — TLD selector in search
      register.tsx                 MODIFIED — USDC flow, NFT gate
      admin.tsx                    NEW — admin panel
      import.tsx                   DISABLED
      ens-v2.tsx                   DISABLED
      legacyfavourites.tsx         DISABLED
    assets/                        MODIFIED — SimpleX logo only
  public/                          MODIFIED — SimpleX favicon only
  next.config.mjs                  MODIFIED — remove ENS-specific rewrites if any
```

**Verify**: `pnpm dev` opens at localhost:3000. Connect MetaMask to local Hardhat node. Search for name, see availability with correct SNRC pricing, complete registration flow (USDC approve → commit → wait → register), see name in "My Names" with contact/channel link fields.

### Phase 12: Playwright e2e

Adapt the existing ENS app Playwright suite (`e2e/specs/`) rather than writing from scratch. The ENS app already has stateless and stateful e2e test infrastructure with Hardhat/Anvil backends.

- **Keep**: ENS app's Playwright config, fixtures, wallet injection pattern (test mnemonic)
- **Adapt existing specs**: rewire registration, renewal, profile specs to use SNRC contracts + USDC flow
- **Add new specs**:
  - `nft-gate.spec.ts`: .simplex blocked without NFT, mint NFT, retry → succeeds
  - `categorized-links.spec.ts`: set + read contact and channel links
  - `admin.spec.ts`: lower char length, reserve/release names
  - `tld-selector.spec.ts`: switch between .simplex and .testing, verify different behavior
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
6. Manual demo: register `testname.simplex` with NFT gate, register `testname.testing` without, set blob data, read back, renew, transfer ownership

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
