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

Full fork of `ensdomains/ens-contracts`, adapted:
- **Registry**: `SNRCRegistry` (UUPS-upgradeable ENSRegistry fork)
- **Resolver**: `SimplexResolver` — categorized link storage per name (contact link, channel link, extensible via `bytes32` keys)
- **Registrar**: `SNRCBaseRegistrar` (ERC-721) — two instances, one for `.simplex`, one for `.testing`
- **Controller**: `SimplexController` — commit-reveal, stablecoin pricing, NFT gate, reserved names, min-length gate. Two instances with different configs per TLD
- **NameWrapper**: `SNRCNameWrapper` (ERC-1155 fuses, fork of ENS NameWrapper)
- **Root + ReverseRegistrar**: standard ENS forks
- **Payment**: ERC-20 stablecoin (USDC/USDT), not ETH
- **NFT gate**: checks `balanceOf(sender) > 0` on the SMPXNFT contract (`0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`, ERC-721, 560 tokens, name "SimpleX NFT: SMPX testnet access", symbol "SMPXNFT")
- **Frontend**: fork of `ensdomains/ens-app-v3` (Next.js + styled-components + wagmi/viem), restyled to SimpleX branding, surgically adapted
- **Deployment targets**: Hardhat local, Hoodi testnet, Ethereum mainnet

---

## Architecture

### Single registry, dual registrar/controller pairs

```
SNRCRegistry (one instance, UUPS proxy)
  ├─ .simplex node → SNRCBaseRegistrar#1 → SimplexController#1
  │                   (NFT-gated, 6+ chars, reserved names, stablecoin pricing)
  ├─ .testing node → SNRCBaseRegistrar#2 → SimplexController#2
  │                   (open, 3+ chars, free or nominal fee)
  ├─ .addr.reverse → ReverseRegistrar
  └─ Root (assigns TLD ownership, lockable)

SimplexResolver (one instance, UUPS proxy)
  mapping(bytes32 node => mapping(bytes32 category => bytes data))
  categories: keccak256("contact"), keccak256("channel"), ... extensible

SNRCNameWrapper (one instance, UUPS proxy)
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

| Length | Multiplier | Example (base=100 USDC) |
|--------|------------|------------------------|
| 6+     | 1x         | 100 USDC/year          |
| 5      | 8x         | 800 USDC/year          |
| 4      | 32x        | 3,200 USDC/year        |
| 3      | 128x       | 12,800 USDC/year       |

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

**Goal**: `SNRCRegistry` with UUPS upgradeability.

**`contracts/interfaces/ISNRC.sol`** — rename ENS.sol interface. Same events/functions (setRecord, setSubnodeOwner, setResolver, setOwner, setTTL, owner, resolver, ttl, recordExists).

**`contracts/registry/SNRCRegistry.sol`** — fork ENSRegistry:
- Replace constructor with `initialize()` + `UUPSUpgradeable` + `OwnableUpgradeable` (OZ v5)
- Keep `Record` struct: `{owner, resolver, ttl}`
- Keep `records` mapping, `operators` mapping, `authorised` modifier
- Add `_authorizeUpgrade()` restricted to owner

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

**Goal**: Fork BaseRegistrarImplementation with UUPS.

**`contracts/registrar/SNRCBaseRegistrar.sol`**:
- `initialize(ISNRC registry, bytes32 baseNode)` — UUPS
- ERC-721: tokenId = `uint256(keccak256(label))`
- Expiry tracking: `mapping(uint256 => uint256) public nameExpires`
- 90-day grace period constant
- Controller authorization: `mapping(address => bool) public controllers`
- Functions: `register(id, owner, duration)`, `renew(id, duration)`, `reclaim(id, owner)`, `available(id)`, `nameExpires(id)`, `addController()`, `removeController()`
- Two instances: one with `baseNode = namehash("simplex")`, one with `baseNode = namehash("testing")`

**Verify**: Register name, check expiry, renew, verify ERC-721 ownership, reclaim registry record.

### Phase 6: Controller (commit-reveal + pricing + gates)

This is the core SNRC-specific contract — most divergence from ENS lives here.

**`contracts/controller/SimplexPriceOracle.sol`**:
- No Chainlink feed needed — prices are in stablecoin directly
- `uint256 public baseRate` (admin-settable, default 100_000_000 = 100 USDC at 6 decimals)
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

**`contracts/wrapper/SNRCNameWrapper.sol`** — fork NameWrapper.sol:
- Replace `.eth` references with parameterized TLD support
- UUPS upgradeability
- Keep fuse system: CANNOT_UNWRAP, CANNOT_TRANSFER, PARENT_CANNOT_CONTROL, etc.
- Rename `wrapETH2LD` → `wrapSNRC2LD`
- Keep subdomain management, expiry normalization

Supporting files (direct forks):
- `contracts/wrapper/ERC1155Fuse.sol`
- `contracts/wrapper/Controllable.sol`
- `contracts/wrapper/StaticMetadataService.sol`

**Verify**: Wrap name, verify ERC-1155 token, burn fuses, verify restrictions, unwrap.

### Phase 8: Reverse registrar + Root

**`contracts/registry/ReverseRegistrar.sol`** — fork from ENS, maps addresses back to SimpleX names.

**`contracts/root/Root.sol`** — fork from ENS:
- Controls root node (0x0)
- `setSubnodeOwner(label, owner)` — assigns TLD ownership
- `lock(label)` — permanently locks a TLD
- Non-upgradeable (trivially simple)

**Verify**: Root assigns TLD ownership. Locked TLDs cannot be reassigned.

### Phase 9: Deployment scripts

**`scripts/deploy-local.ts`** — deployment order (critical dependency chain):
1. Deploy mocks: TestUSDC, MockSMPXNFT
2. Mint test NFTs + USDC to Hardhat accounts
3. Deploy SNRCRegistry (UUPS proxy)
4. Deploy SimplexResolver (UUPS proxy)
5. Deploy ReverseRegistrar
6. Deploy Root (non-proxy), transfer registry root to Root
7. Deploy SNRCBaseRegistrar for `.simplex` (UUPS proxy, `baseNode = namehash("simplex")`)
8. Deploy SNRCBaseRegistrar for `.testing` (UUPS proxy, `baseNode = namehash("testing")`)
9. Root: set subnode owners for both TLDs, lock both
10. Deploy SimplexPriceOracle (baseRate = 100 USDC/year)
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

**Approach: surgical changes only.** The ENS app has ~100+ components and a polished UX. We keep everything that works and change only what differs.

#### A. Style changes (SimpleX branding)

Override Thorin design tokens to match simplex.chat:
- Font: `Raleway, Arial, Helvetica, sans-serif` (Thorin default is Inter)
- Primary/accent: `#02c0ff` (cyan)
- Text: `#062d56` (dark blue)
- Highlight: `#fbd561` (yellow)
- Error: `#f95a2c` (tomato)
- Background: `#f8f8f6` (off-white)
- Buttons: `border-radius: 25px`, bg `#02c0ff`
- Inputs: bg `#f1f1f1`, `border-radius: 10px`

Where to change:
- `src/pages/_app.tsx` — replace Thorin `ThorinGlobalStyles` or provide custom theme override
- Logo/favicon/meta in `public/` and `src/assets/`
- If Thorin's `lightTheme`/`darkTheme` objects are passed to `ThemeProvider`, override the token values there (colors, fonts, radii) — this is one object, not scattered CSS

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
- **Pricing display**: Show SNRC pricing table (100/800/3200/12800 USDC) instead of ENS pricing.
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
      useNameAvailability.ts       MODIFIED — call SNRCBaseRegistrar.available()
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
      index.tsx                    MODIFIED — SimpleX branding, TLD selector in search
      register.tsx                 MODIFIED — USDC flow, NFT gate
      admin.tsx                    NEW — admin panel
      import.tsx                   DISABLED
      ens-v2.tsx                   DISABLED
      legacyfavourites.tsx         DISABLED
    assets/                        MODIFIED — SimpleX logo, favicon
  public/                          MODIFIED — SimpleX assets
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
